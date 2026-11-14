import { mkdir, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import {
  ProjectTeam,
  readTeamJson,
  readTeamResource,
  resolveTeamPath,
  type ProjectTeamBinding
} from './project-team-config'
import { buildTeamLaunch } from './project-team-launch'
import { teamPaneIdentity, type SavedTeamTab } from './project-team-pane'

const Tabs = z.object({
  tabs: z.array(
    z.object({
      parentTabId: z.string(),
      leafId: z.string().optional(),
      customTitle: z.string().nullable().optional(),
      terminal: z.string().nullish(),
      launchAgent: z.string().optional()
    })
  )
})
const Created = z.object({ terminal: z.object({ handle: z.string(), tabId: z.string() }) })
export type TeamRpc = (method: string, params: Record<string, unknown>) => Promise<unknown>
export type TeamWorkspace = { id: string; path: string; hostId?: string }
export type TeamRoleResult = {
  role: string
  status: 'present' | 'started' | 'blocked'
  terminal?: string
  code?: string
}
export class ProjectTeamService {
  private active = new Map<string, Promise<TeamRoleResult[]>>()
  // An uncertain launch is retried with the same mutation identity, never a new terminal.
  private mutations = new Map<string, string>()
  constructor(
    private readonly deps: {
      call: TeamRpc
      workspaces: () => Promise<TeamWorkspace[]>
      existingTabs?: (worktreeId: string) => SavedTeamTab[]
      profile: string
      prepareLaunch?: typeof buildTeamLaunch
      onError?: (role: string, error: unknown) => void
    }
  ) {}

  ensure(binding: ProjectTeamBinding): Promise<TeamRoleResult[]> {
    if (!binding.enabled) {
      return Promise.resolve([])
    }
    const key = `${binding.config}\n${binding.projectRoot}`
    const existing = this.active.get(key)
    if (existing) {
      return existing
    }
    const task = this.apply(binding).finally(() => this.active.delete(key))
    this.active.set(key, task)
    return task
  }
  private async apply(binding: ProjectTeamBinding): Promise<TeamRoleResult[]> {
    const team = ProjectTeam.parse(await readTeamJson(binding.config))
    const workspaces = await this.deps.workspaces()
    const results: TeamRoleResult[] = []
    for (const role of team.roles) {
      try {
        const cwd = resolveTeamPath(role.cwd, binding.projectRoot)
        const samePath = (value: string) =>
          process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value
        const workspace = workspaces.find(
          (w) => (!w.hostId || w.hostId === 'local') && samePath(w.path) === samePath(cwd)
        )
        if (!workspace) {
          throw new Error('team_workspace_not_imported')
        }
        const target = `id:${workspace.id}`
        const inventory = Tabs.parse(
          await this.deps.call('session.tabs.list', { worktree: target })
        )
        const matches = inventory.tabs.filter((tab) => tab.customTitle === role.title)
        if (!matches.length) {
          for (const saved of this.deps.existingTabs?.(workspace.id) ?? []) {
            if (saved.customTitle === role.title) {
              matches.push({
                parentTabId: saved.id,
                customTitle: saved.customTitle,
                leafId: saved.leafId
              })
            }
          }
        }
        let replacement: { tabId: string; leafId?: string } | undefined
        let emptyTerminal: string | undefined
        if (matches.length) {
          let tab = matches.find((t) => t.launchAgent === role.provider && t.terminal)
          if (!tab) {
            const existing = matches.find((t) => t.launchAgent === role.provider) ?? matches[0]
            const warmed = Created.parse(
              await this.deps.call('terminal.create', {
                worktree: target,
                ...teamPaneIdentity(existing),
                focus: false,
                activate: false
              })
            )
            tab = { ...existing, terminal: warmed.terminal.handle, launchAgent: role.provider }
          }
          if (!tab?.terminal) {
            results.push({
              role: role.id,
              status: 'blocked',
              code: 'team_existing_role_requires_attention'
            })
            continue
          }
          let terminal = tab.terminal
          const inspect = async (terminal: string) => {
            const running = z
              .object({ isRunningAgent: z.boolean() })
              .parse(await this.deps.call('terminal.isRunningAgent', { terminal }))
            const process = z
              .object({
                process: z.object({
                  foregroundProcess: z.string().nullable().optional(),
                  hasChildProcesses: z.boolean().optional()
                })
              })
              .parse(
                await this.deps.call('terminal.inspectProcess', {
                  terminal,
                  scanChildProcesses: true
                })
              ).process
            return { running, process }
          }
          let inspection
          try {
            inspection = await inspect(terminal)
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !['terminal_gone', 'terminal_handle_stale'].includes(error.message)
            ) {
              throw error
            }
            const restored = Created.parse(
              await this.deps.call('terminal.create', {
                worktree: target,
                ...teamPaneIdentity(tab),
                focus: false,
                activate: false
              })
            )
            terminal = restored.terminal.handle
            inspection = await inspect(restored.terminal.handle)
          }
          const { running, process } = inspection
          const name = process.foregroundProcess
            ?.replaceAll('\\', '/')
            .split('/')
            .pop()
            ?.toLowerCase()
          const emptyShell =
            process.hasChildProcesses === false &&
            !!name &&
            ['pwsh.exe', 'powershell.exe', 'cmd.exe', 'bash', 'zsh', 'fish', 'sh'].includes(name)
          if (running.isRunningAgent && !emptyShell) {
            results.push({ role: role.id, status: 'present', terminal })
            continue
          }
          if (!emptyShell) {
            results.push({
              role: role.id,
              status: 'blocked',
              code: 'team_existing_role_requires_attention'
            })
            continue
          }
          replacement = teamPaneIdentity(tab)
          emptyTerminal = terminal
        }
        const sources: string[] = []
        for (const resource of role.instructions) {
          sources.push(`## ${resource}\n${await readTeamResource(binding.config, resource)}`)
        }
        let context = `# ${role.title}\nModel: ${role.model}; reasoning: ${role.effort}\nStart a fresh conversation and wait for a task. Do not reuse terminal, workspace, or session IDs from old files. Read {{runtimeMap}} for current role endpoints.\n${sources.join('\n\n')}`
        context = context
          .replaceAll('{{projectRoot}}', binding.projectRoot)
          .replaceAll('{{home}}', homedir())
          .replaceAll('{{runtimeMap}}', join(this.deps.profile, 'project-team-runtime.json'))
        if (Buffer.byteLength(context) > 2 * 1024 * 1024) {
          throw new Error('team_context_too_large')
        }
        const key = createHash('sha256')
          .update(`${binding.config}\n${binding.projectRoot}\n${role.id}`)
          .digest('hex')
        const file = join(this.deps.profile, 'project-team-context', `${key}.md`)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, context)
        const launch = await (this.deps.prepareLaunch ?? buildTeamLaunch)(
          role,
          binding.config,
          binding.projectRoot,
          file
        )
        if (emptyTerminal) {
          const stopped = z
            .object({ close: z.object({ ptyKilled: z.literal(true) }) })
            .safeParse(await this.deps.call('terminal.close', { terminal: emptyTerminal }))
          if (!stopped.success) {
            throw new Error('team_empty_shell_stop_not_confirmed')
          }
        }
        const mutation = this.mutations.get(key) ?? randomUUID()
        this.mutations.set(key, mutation)
        const created = Created.parse(
          await this.deps.call('terminal.create', {
            worktree: target,
            clientMutationId: mutation,
            ...replacement,
            command: launch.command,
            env: launch.env,
            launchConfig: launch.launchConfig,
            launchAgent: role.provider,
            ...(launch.shell ? { shell: launch.shell } : {}),
            title: role.title,
            focus: false,
            activate: false,
            startupCommandDelivery: 'shell-ready'
          })
        )
        await this.deps.call('session.tabs.setTabProps', {
          worktree: target,
          tabId: created.terminal.tabId,
          customTitle: role.title
        })
        results.push({ role: role.id, status: 'started', terminal: created.terminal.handle })
      } catch (error) {
        this.deps.onError?.(role.id, error)
        const message = error instanceof Error ? error.message : ''
        results.push({
          role: role.id,
          status: 'blocked',
          code: message.startsWith('team_') ? message : 'team_initialization_failed'
        })
      }
    }
    return results
  }
}

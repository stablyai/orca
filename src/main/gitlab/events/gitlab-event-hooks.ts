// The GitLab side of each bot automation's GitLab rule: one signed webhook per project it names, all
// pointing at the automation's own Orca hook. The upkeep pass makes them, signs them again with a new
// secret when the projects, event or hook key change, and removes them when the rule goes.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  gitlabEventRuleOf,
  gitlabHookFlag,
  type GitLabEventRule,
  type GitLabHookFlag
} from '../../../shared/automation-gitlab-triggers'
import { automationWebhookTrigger } from '../../../shared/automation-event-triggers'
import type { Automation } from '../../../shared/automations/automation-definition'
import { hookIdOfRule } from '../../../shared/connector-webhook-contract'
import type { GitLabProjectHooks } from './gitlab-project-hooks'

const Saved = z.object({
  host: z.string().optional(),
  flag: z.enum(['note_events', 'issues_events', 'merge_requests_events', 'pipeline_events']),
  /** The Orca hook's key generation the GitLab webhooks' URL has; -1 until every one is signed. */
  keyGeneration: z.number().int(),
  /** GitLab's webhook id, by project path. */
  projects: z.record(z.string(), z.number().int())
})
type SavedHooks = z.infer<typeof Saved>
const SavedFile = z.object({ hooks: z.record(z.string(), Saved) })

/** What this host made on GitLab, by Orca hook id. Holds no secret. */
export class GitLabEventHookStore {
  constructor(private readonly file: string) {}

  async all(): Promise<Record<string, SavedHooks>> {
    try {
      return SavedFile.parse(JSON.parse(await readFile(this.file, 'utf8'))).hooks
    } catch {
      return {}
    }
  }

  async write(hookId: string, saved: SavedHooks | null): Promise<void> {
    const { [hookId]: _old, ...others } = await this.all()
    const hooks = saved ? { ...others, [hookId]: saved } : others
    if (Object.keys(hooks).length === 0) {
      await rm(this.file, { force: true })
      return
    }
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(this.file, `${JSON.stringify({ hooks })}\n`, { mode: 0o600 })
  }
}

export type GitLabEventHooksHost = {
  automations: () => readonly Automation[]
  /** Raised each time the hook's key rotates, which changes its URL. */
  keyGeneration: (hookId: string) => Promise<number>
  /** The hook's full address, key included. */
  url: (hookId: string) => Promise<string>
  /** Makes the hook accept only calls signed with this Standard Webhooks secret. */
  setSecret: (hookId: string, secret: string) => Promise<void>
  /** A status line in the bot's chat. */
  tell: (botId: string, line: string) => void
}

type Wanted = { botId: string; automationName: string; rule: GitLabEventRule }

/** A Standard Webhooks secret, as GitLab's signing_token takes it: whsec_ and 32 random bytes. */
function signingSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`
}

function wantedHooks(automations: readonly Automation[]): Map<string, Wanted> {
  const wanted = new Map<string, Wanted>()
  for (const automation of automations) {
    const trigger = automationWebhookTrigger(automation)
    const hookId = trigger ? hookIdOfRule(trigger.id) : null
    const rule = trigger ? gitlabEventRuleOf(trigger) : null
    if (hookId && rule && automation.bot) {
      wanted.set(hookId, { botId: automation.bot.botId, automationName: automation.name, rule })
    }
  }
  return wanted
}

function upToDate(
  saved: SavedHooks,
  rule: GitLabEventRule,
  flag: GitLabHookFlag,
  keyGeneration: number
) {
  const projects = Object.keys(saved.projects).sort()
  return (
    saved.host === rule.host &&
    saved.flag === flag &&
    saved.keyGeneration === keyGeneration &&
    JSON.stringify(projects) === JSON.stringify([...rule.projects].sort())
  )
}

export class GitLabEventHooks {
  // The last failure told to each hook's bot, so a pass every half hour doesn't repeat it.
  private readonly told = new Map<string, string>()

  constructor(
    private readonly host: GitLabEventHooksHost,
    private readonly gitlab: GitLabProjectHooks,
    private readonly store: GitLabEventHookStore
  ) {}

  async reconcile(): Promise<void> {
    const wanted = wantedHooks(this.host.automations())
    for (const [hookId, saved] of Object.entries(await this.store.all())) {
      if (!wanted.has(hookId)) {
        await this.removeAll(hookId, saved)
      }
    }
    for (const [hookId, entry] of wanted) {
      try {
        await this.keep(hookId, entry)
        this.told.delete(hookId)
      } catch (error) {
        const line = error instanceof Error ? error.message : String(error)
        console.warn('[gitlab-events] could not keep a GitLab webhook', line)
        if (this.told.get(hookId) !== line) {
          this.told.set(hookId, line)
          this.host.tell(entry.botId, `“${entry.automationName}”: ${line}`)
        }
      }
    }
  }

  private async removeAll(hookId: string, saved: SavedHooks): Promise<void> {
    const left = { ...saved.projects }
    for (const [project, id] of Object.entries(saved.projects)) {
      try {
        await this.gitlab.remove(saved.host, project, id)
        delete left[project]
      } catch (error) {
        console.warn('[gitlab-events] could not remove a GitLab webhook', error)
      }
    }
    await this.store.write(
      hookId,
      Object.keys(left).length > 0 ? { ...saved, projects: left } : null
    )
  }

  private async keep(hookId: string, { automationName, rule }: Wanted): Promise<void> {
    const flag = gitlabHookFlag(rule.event)
    const keyGeneration = await this.host.keyGeneration(hookId)
    let saved = (await this.store.all())[hookId]
    if (saved && upToDate(saved, rule, flag, keyGeneration)) {
      return
    }
    if (saved && saved.host !== rule.host) {
      await this.removeAll(hookId, saved)
      saved = (await this.store.all())[hookId]
      if (saved) {
        throw new Error(
          'GitLab still has this rule’s webhooks on the earlier host; trying again later.'
        )
      }
    }
    // Each project's webhook takes the new secret before the Orca hook does. A project GitLab refuses
    // doesn't hold the others back: the hook takes the secret once any project has it.
    const hook = {
      url: await this.host.url(hookId),
      signingToken: signingSecret(),
      flag,
      name: `Orca: ${automationName}`.slice(0, 255)
    }
    const projects: Record<string, number> = {}
    const failures: string[] = []
    let signed = 0
    for (const project of rule.projects) {
      const id = saved?.projects[project]
      try {
        if (id === undefined) {
          projects[project] = await this.gitlab.create(rule.host, project, hook)
        } else {
          await this.gitlab.update(rule.host, project, id, hook)
          projects[project] = id
        }
        signed += 1
      } catch (error) {
        // Still GitLab's, on the earlier secret: the next pass updates it instead of adding another.
        if (id !== undefined) {
          projects[project] = id
        }
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }
    for (const [project, id] of Object.entries(saved?.projects ?? {})) {
      if (!rule.projects.includes(project)) {
        try {
          await this.gitlab.remove(rule.host, project, id)
        } catch (error) {
          projects[project] = id
          failures.push(error instanceof Error ? error.message : String(error))
        }
      }
    }
    const written = { host: rule.host, flag, projects }
    await this.store.write(hookId, { ...written, keyGeneration: -1 })
    if (signed > 0) {
      await this.host.setSecret(hookId, hook.signingToken)
    }
    if (failures.length > 0) {
      throw new Error(failures.join(' '))
    }
    await this.store.write(hookId, { ...written, keyGeneration })
  }
}

import { lstatSync, readdirSync, realpathSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { z } from 'zod'
import {
  describeClaudeProfile,
  assertClaudeProfileDescendant,
  readClaudeProfileObject
} from './claude-profile-paths'
import { provisionClaudeAccountProfile } from './claude-profile-setup'
import { publishClaudeProfilePointer, withdrawClaudeProfilePointer } from './claude-profile-pointer'
import { applyWorkspaceTrustOnThisHost } from '../execution-host-workspace-trust'
import { ClaudeHookService } from '../claude/hook-service'
import { WSL_CLAUDE_PROFILE_POINTER_FROM_HOME } from '../../shared/claude-profile-routing'

export const ClaudeWslProfileRequest = z.object({
  action: z.enum(['inspect', 'setup', 'publish', 'withdraw', 'trust']),
  distro: z.string().min(1),
  userHome: z.string().startsWith('/'),
  accountId: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .nullable(),
  workspacePath: z.string().startsWith('/').optional(),
  hooksEnabled: z.boolean().default(false),
  claudeVersion: z.string().optional()
})
export type ClaudeWslProfileRequest = z.infer<typeof ClaudeWslProfileRequest>

/** All profile reads and writes happen in the distro, never through a Windows share. */
export async function runClaudeWslProfileRequest(request: ClaudeWslProfileRequest) {
  const { userHome, distro, accountId } = request
  const dataRoot = join(userHome, '.local', 'share', 'orca')
  const pointer = join(userHome, WSL_CLAUDE_PROFILE_POINTER_FROM_HOME)
  if (request.action === 'withdraw') {
    withdrawClaudeProfilePointer(pointer)
    return { ready: false, provisioned: false }
  }
  const profile = accountId
    ? describeClaudeProfile(dataRoot, accountId, {
        executionHostId: 'local',
        runtime: 'wsl',
        distro
      })
    : null
  let ready = !profile
  let provisioned = false
  if (profile) {
    assertClaudeProfileDescendant(dataRoot, profile.home)
    const markerPath = join(dirname(profile.home), 'profile.json')
    assertClaudeProfileDescendant(dataRoot, markerPath)
    const marker = readClaudeProfileObject(markerPath)
    if (marker.kind === 'unavailable') {
      throw new Error('WSL Claude profile ownership is unreadable')
    }
    ready =
      marker.kind === 'present' &&
      marker.value.version === 1 &&
      marker.value.accountId === accountId &&
      marker.value.runtime === 'wsl' &&
      marker.value.distro === distro &&
      lstatSync(markerPath).isFile() &&
      lstatSync(profile.home).isDirectory()
    if (ready) {
      try {
        provisioned = Boolean(lstatSync(join(profile.home, 'projects')))
      } catch {
        /* Setup has not finished. */
      }
    }
  }
  if (request.action === 'inspect') {
    const homes = [join(userHome, '.claude')]
    let ids: string[] = []
    try {
      ids = readdirSync(join(dataRoot, 'claude-profiles'))
    } catch {
      /* No profiles yet. */
    }
    for (const id of ids) {
      try {
        const candidate = describeClaudeProfile(dataRoot, id, {
          executionHostId: 'local',
          runtime: 'wsl',
          distro
        })
        assertClaudeProfileDescendant(dataRoot, candidate.home)
        const markerFile = join(dirname(candidate.home), 'profile.json')
        assertClaudeProfileDescendant(dataRoot, markerFile)
        const marker = readClaudeProfileObject(markerFile)
        if (
          marker.kind === 'present' &&
          marker.value.version === 1 &&
          marker.value.accountId === id &&
          marker.value.runtime === 'wsl' &&
          marker.value.distro === distro &&
          lstatSync(candidate.home).isDirectory()
        ) {
          homes.push(candidate.home)
        }
      } catch {
        /* Unowned folders are not reader roots. */
      }
    }
    const historyHomes: Record<'projects' | 'transcripts', string[]> = {
      projects: [],
      transcripts: []
    }
    for (const surface of ['projects', 'transcripts'] as const) {
      const allowed = new Set(
        homes.map((home) => {
          try {
            return join(realpathSync.native(home), surface)
          } catch {
            return join(home, surface)
          }
        })
      )
      const roots = homes.flatMap((home) => {
        try {
          const root = realpathSync.native(join(home, surface))
          return allowed.has(root) ? [dirname(root)] : []
        } catch {
          return []
        }
      })
      historyHomes[surface] = [...new Set(roots)]
    }
    return { ready, provisioned, homes, historyHomes }
  }
  if (!ready) {
    throw new Error('Selected WSL Claude account needs a fresh sign-in')
  }
  if (request.action === 'publish') {
    publishClaudeProfilePointer(pointer, profile?.home ?? null)
    return { ready, provisioned }
  }
  if (!profile) {
    throw new Error('System Default does not need profile setup')
  }
  if (request.action === 'trust') {
    if (request.workspacePath) {
      await applyWorkspaceTrustOnThisHost('claude', request.workspacePath, () => ({
        homes: [userHome],
        agentHome: userHome,
        codexConfigFiles: () => [],
        deadlineMs: 1_500,
        claudeConfig: () => ({ configFile: join(profile.home, '.claude.json'), keyStyle: 'posix' })
      }))
    }
    return { ready, provisioned }
  }
  const report = await provisionClaudeAccountProfile({
    dataRoot,
    userHome,
    profile,
    installHooks: request.hooksEnabled
      ? (target) =>
          new ClaudeHookService().install({ ...target, claudeVersion: request.claudeVersion })
      : null
  })
  return { ready, provisioned: report.outcome === 'prepared', report }
}

import { chmod, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AntigravityChatSignInIntent } from '../../shared/agent-accounts/antigravity/antigravity-account-types'
import { prepareAcpLaunch } from '../acp/launch/acp-structured-launch-preparation'
import type { AcpLaunchInvocation } from '../acp/launch/acp-structured-launch-resolution'
import type { AcpAgentConnection, AcpSignInWatch } from '../acp/process/acp-agent-connection'
import { acpRunFolder } from '../acp/launch/acp-private-temp'
import type { AntigravityChatAuthConfig } from '../../shared/agent-accounts/antigravity/antigravity-chat-auth-config'
import { AntigravitySignInSentence } from './antigravity-chat-account'
import { removeAntigravitySignInSessionFiles } from './antigravity-sign-in-session-files'

export async function antigravitySignInHome(
  launch: AcpLaunchInvocation,
  intent: AntigravityChatSignInIntent,
  watch: AcpSignInWatch,
  closed: () => void
) {
  const home = launch.env.GEMINI_HOME
  // A failed or orphaned replacement must never write the working account's credentials.
  const stage = intent === 'changeAccount' ? await acpRunFolder(join(home, 'sign-in')) : null
  const cwd = stage
    ? join(stage.path, 'workspace')
    : await mkdtemp(join(tmpdir(), 'orca-antigravity-sign-in-'))
  const selectedHome = stage ? join(stage.path, 'home') : home
  let selected = launch
  try {
    if (stage) {
      await mkdir(cwd)
      selected = await prepareAcpLaunch(
        async () => ({ ...launch, env: { ...launch.env, GEMINI_HOME: selectedHome } }),
        closed
      )
    }
  } catch (error) {
    await stage?.remove()
    throw error
  }
  const servers = new Set<AcpAgentConnection>()
  let session: string | null = null
  let removed = false
  const dispose = async (): Promise<void> => {
    if (session === null || removed || servers.size > 0) {
      return
    }
    removed = true
    if (stage) {
      await stage.remove()
      return
    }
    await Promise.all([
      removeAntigravitySignInSessionFiles(home, session, cwd),
      rm(cwd, { recursive: true, force: true })
    ]).catch((error: unknown) => {
      console.warn('[antigravity] sign-in session files not removed:', error)
    })
  }
  return {
    home: selectedHome,
    launch: { ...selected, args: selected.spec.args({ fullAccess: false, pluginDirs: [] }), cwd },
    watch: stage ? { ...watch, answered: () => {} } : watch,
    replacement: stage !== null,
    spawned: (server: AcpAgentConnection): void => {
      servers.add(server)
      server.onExit(() => {
        servers.delete(server)
        void dispose()
      })
    },
    remove: async (sessionId: string): Promise<void> => {
      session = sessionId
      for (const server of servers) {
        if (server.exited) {
          servers.delete(server)
        }
      }
      await dispose()
    }
  }
}

/** Validate before the final cancellation check; the returned commit runs after it. */
export async function antigravitySignInCredentialCommit(
  stageHome: string,
  home: string,
  method: AntigravityChatAuthConfig['method']
): Promise<() => Promise<void>> {
  const tokenName = method === 'oauth-business' ? 'acp_business_token.json' : 'acp_token.json'
  const token = join(stageHome, 'antigravity-acp', tokenName)
  try {
    const saved = await lstat(token)
    if (!saved.isFile() || saved.size === 0) {
      throw new Error('Missing replacement credential')
    }
    await chmod(token, 0o600)
  } catch (cause) {
    throw new AntigravitySignInSentence(
      'Antigravity did not save a replacement Chat sign-in. Start sign-in again.',
      { cause }
    )
  }
  return async () => {
    try {
      await rename(token, join(home, 'antigravity-acp', tokenName))
    } catch (cause) {
      throw new AntigravitySignInSentence(
        'Antigravity could not save the new Chat sign-in. Check that Orca can write its data folder and start sign-in again.',
        { cause }
      )
    }
  }
}

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ExecCommandModule from '../../ssh/remote-exec/remote-exec-command'
import { unusedOrcadHostTransport } from '../testing/managed-host-transport.test-fixture'

// Host-script checks run separately against the real script; these cases cover client interpretation.
const remote = vi.hoisted((): { commands: string[]; reply: string } => ({
  commands: [],
  reply: ''
}))
vi.mock('../../ssh/remote-exec/remote-exec-command', async (importOriginal) => ({
  ...(await importOriginal<typeof ExecCommandModule>()),
  execCommand: async (_conn: unknown, command: string) => {
    remote.commands.push(command)
    return command.includes('script-present') ? 'ORCAD_HOST_SCRIPT_PRESENT\n' : remote.reply
  }
}))

const { findExitedOwnLockToken } = await import('./orcad-exited-own-lock')
const { initOrcadHeldFenceTokenFile, ORCAD_HELD_FENCE_TOKENS_FILE_NAME } =
  await import('./orcad-held-fence-tokens')
const { getRemoteHostPlatform } = await import('../../ssh/remote-host/ssh-remote-platform')

// Above every Linux and macOS pid_max, so no process can hold it.
const EXITED_PID = 4_194_304 + 1
const host = getRemoteHostPlatform('win32-x64')
const baseDir = 'C:/Users/me/.orca-remote'
const lockDir = `${baseDir}/.orcad-activation-transaction/.install-lock`
let store = ''
let home = ''

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orcad-exited-win-'))
  mkdirSync(join(home, 'data'))
  initOrcadHeldFenceTokenFile(join(home, 'data', 'orca-data.json'))
  store = join(home, 'data', ORCAD_HELD_FENCE_TOKENS_FILE_NAME)
  remote.commands = []
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

function hold(...entries: { token: string; pid: number }[]): void {
  const bootedAt = Date.now() - uptime() * 1000
  writeFileSync(
    store,
    JSON.stringify(entries.map((e) => ({ ...e, host: hostname(), bootedAt, at: Date.now() })))
  )
}

function find(guardsStateMutation: boolean): Promise<string | null> {
  const target = { conn: unusedOrcadHostTransport(), host }
  return findExitedOwnLockToken(target, lockDir, { baseDir, guardsStateMutation })
}

describe('reclaiming this desktop’s exited lock on a Windows host', () => {
  it('ignores an answer naming a token it did not offer', async () => {
    hold({ token: 't-exited', pid: EXITED_PID })
    remote.reply = 'EXITED_OWNER t-foreign\n'
    await expect(find(false)).resolves.toBeNull()
  })
})

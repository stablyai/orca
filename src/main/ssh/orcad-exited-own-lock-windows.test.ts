import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir, uptime } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DeployHelpers from './ssh-relay-deploy-helpers'

// The host script's own checks are covered against the real script; here only the client's part.
const remote = vi.hoisted((): { commands: string[]; reply: string } => ({
  commands: [],
  reply: ''
}))
vi.mock('./ssh-relay-deploy-helpers', async (importOriginal) => ({
  ...(await importOriginal<typeof DeployHelpers>()),
  execCommand: async (_conn: unknown, command: string) => {
    remote.commands.push(command)
    return command.includes('script-present') ? 'ORCAD_HOST_SCRIPT_PRESENT\n' : remote.reply
  }
}))

const { findExitedOwnLockToken } = await import('./orcad-exited-own-lock')
const { initOrcadHeldFenceTokenFile, ORCAD_HELD_FENCE_TOKENS_FILE_NAME } =
  await import('./orcad-held-fence-tokens')
const { getRemoteHostPlatform } = await import('./ssh-remote-platform')

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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked, so the connection is never used.
  const target = { conn: {} as never, host }
  return findExitedOwnLockToken(target, lockDir, { baseDir, guardsStateMutation })
}

const checkOps = (): string[] => remote.commands.filter((c) => c.includes('fence-exited-owner'))

describe('reclaiming this desktop’s exited lock on a Windows host', () => {
  it('asks the host script about exited holders only', async () => {
    hold({ token: 't-exited', pid: EXITED_PID }, { token: 't-live', pid: process.pid })
    remote.reply = 'EXITED_OWNER t-exited\n'
    await expect(find(true)).resolves.toBe('t-exited')
    const [op] = checkOps()
    expect(op).toContain('t-exited')
    expect(op).not.toContain('t-live')
    expect(op).toMatch(/fence-exited-owner"? "?[^ ]*\.install-lock"? "?1"?/u)
  })

  it('finds nothing when the host kept the lock', async () => {
    hold({ token: 't-exited', pid: EXITED_PID })
    remote.reply = 'KEPT\n'
    await expect(find(false)).resolves.toBeNull()
    expect(checkOps()).toHaveLength(1)
  })

  it('ignores an answer naming a token it did not offer', async () => {
    hold({ token: 't-exited', pid: EXITED_PID })
    remote.reply = 'EXITED_OWNER t-foreign\n'
    await expect(find(false)).resolves.toBeNull()
  })

  it('asks the host nothing while no holder is proven exited', async () => {
    hold({ token: 't-live', pid: process.pid })
    await expect(find(true)).resolves.toBeNull()
    expect(remote.commands).toEqual([])
  })

  it('falls back to the stale window when the check would not fit cmd.exe', async () => {
    hold({ token: 't-exited', pid: EXITED_PID })
    remote.reply = 'EXITED_OWNER t-exited\n'
    const deep = `C:/Users/me/${'nested-folder/'.repeat(200)}.orca-remote`
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand is mocked, so the connection is never used.
    const target = { conn: {} as never, host }
    await expect(
      findExitedOwnLockToken(target, `${deep}/.install-lock`, {
        baseDir: deep,
        guardsStateMutation: true
      })
    ).resolves.toBeNull()
    expect(remote.commands).toEqual([])
  })
})

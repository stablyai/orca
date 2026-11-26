// What the Move confirmation promises, checked against the files Move edits (synthetic homes only):
// a new or existing entry on the host list, removal tried for eligible copies only, and a backup of
// each settings file before an entry leaves it. Agent-file sync is never started here; the one test
// that needs it runs it explicitly, after Move returned.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as NodeFsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMcpAgentFileAllowed } from '../mcp-host-list'
import { addMcpServers } from '../mcp-host-list-add'
import { McpAgentFileLedger } from '../agent-files/mcp-agent-file-ledger'
import { syncMcpAgentFiles } from '../agent-files/mcp-agent-file-sync'
import { AgentMcpConfigEditError } from './agent-mcp-config-removal'
import {
  listAgentMcpServers,
  moveAgentMcpServer,
  type AgentMcpImportHost
} from './agent-mcp-import'

const spy = vi.hoisted(() => ({
  /** Each file Move asked the removal step to edit, in order. */
  removalPaths: [] as string[],
  /** A file whose backup copy fails, so its edit must not happen. */
  failBackupOf: null as string | null
}))

vi.mock('./agent-mcp-config-removal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent-mcp-config-removal')>()
  return {
    ...actual,
    removeAgentMcpServerEntries: (
      ...args: Parameters<typeof actual.removeAgentMcpServerEntries>
    ) => {
      spy.removalPaths.push(...new Set(args[0].map((source) => source.path)))
      return actual.removeAgentMcpServerEntries(...args)
    }
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>()
  return {
    ...actual,
    copyFile: async (source: string, destination: string, mode?: number) => {
      if (
        spy.failBackupOf !== null &&
        source.endsWith(spy.failBackupOf) &&
        destination.includes('.bak.')
      ) {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
      }
      return actual.copyFile(source, destination, mode)
    }
  }
})

let home: string
let previousSwitch: string | undefined
const at = (path: string) => join(home, path)
const write = (path: string, text: string) => {
  mkdirSync(dirname(at(path)), { recursive: true })
  writeFileSync(at(path), text)
}
const read = (path: string) => readFileSync(at(path), 'utf8')

// A = Codex, B = Cursor: two distinct settings files.
const A = '.codex/config.toml'
const B = '.cursor/mcp.json'
const ALPHA = 'https://alpha.example.test/mcp'
const BETA = 'https://beta.example.test/mcp'
const codexWith = (...names: string[]) =>
  `model = "synthetic"\n${names.map((name) => `\n[mcp_servers.${name}]\nurl = "${name === 'alpha' ? ALPHA : BETA}"\n`).join('')}`
const cursorWith = (...names: string[]) =>
  `{ "mcpServers": { ${names.map((name) => `"${name}": { "url": "${name === 'alpha' ? ALPHA : BETA}" }`).join(', ')} } }\n`

let reached: Set<string>
const host = (): AgentMcpImportHost => ({
  context: { homeDir: home, env: {}, platform: 'darwin' },
  userDataPath: at('orca-data'),
  workspaceFor: async () => () => null,
  isOrcaProject: () => false,
  listReaches: async () => (agent) => reached.has(agent)
})
const rowNamed = async (name: string) =>
  (await listAgentMcpServers(host())).find((row) => row.name === name)!

type Added = { name: string; keepsCopies: boolean }
const recordingAdd =
  (added: Added[], during?: () => void) =>
  async (server: { name: string }, _scope: unknown, keepsCopies: boolean) => {
    added.push({ name: server.name, keepsCopies })
    during?.()
    return { id: `host-${server.name}` }
  }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'orca-mcp-move-confirmation-'))
  reached = new Set(['codex', 'cursor'])
  spy.removalPaths = []
  spy.failBackupOf = null
  previousSwitch = process.env.ORCA_MCP_SERVERS
  process.env.ORCA_MCP_SERVERS = '1'
})

afterEach(() => {
  if (previousSwitch === undefined) {
    delete process.env.ORCA_MCP_SERVERS
  } else {
    process.env.ORCA_MCP_SERVERS = previousSwitch
  }
  rmSync(home, { recursive: true, force: true })
})

describe('Move confirmation: "uses a new or existing entry … tries to remove eligible copies"', () => {
  it('ordinary success: one host addition, both files edited, each .bak holds its pre-edit bytes', async () => {
    write(A, codexWith('alpha'))
    write(B, cursorWith('alpha'))
    const row = await rowNamed('alpha')
    expect(row.removesFrom).toEqual(['codex', 'cursor'])
    const added: Added[] = []

    await moveAgentMcpServer(host(), row.key, recordingAdd(added), row.removesFrom)

    expect(added).toEqual([{ name: 'alpha', keepsCopies: false }])
    expect(spy.removalPaths).toEqual([at(A), at(B)])
    expect(read(A)).not.toContain('[mcp_servers.alpha]')
    expect(read(B)).not.toContain('alpha')
    expect(read(`${A}.bak`)).toBe(codexWith('alpha'))
    expect(read(`${B}.bak`)).toBe(cursorWith('alpha'))
  })

  it('reuse: named agents all lose reach before the first check, so nothing is removed or backed up', async () => {
    write(A, codexWith('alpha'))
    write(B, cursorWith('alpha'))
    write(`${B}.bak`, 'prior synthetic backup\n')
    const row = await rowNamed('alpha')
    reached.clear()
    const added: Added[] = []

    const result = await moveAgentMcpServer(host(), row.key, recordingAdd(added), row.removesFrom)

    // keepsCopies=true is the reuse-or-add path: the RPC reuses a matching host entry as is.
    expect(result).toEqual({ id: 'host-alpha' })
    expect(added).toEqual([{ name: 'alpha', keepsCopies: true }])
    expect(spy.removalPaths).toEqual([])
    expect([read(A), read(B), read(`${B}.bak`)]).toEqual([
      codexWith('alpha'),
      cursorWith('alpha'),
      'prior synthetic backup\n'
    ])
    expect(existsSync(at(`${A}.bak`))).toBe(false)
  })

  it('reach shrink after the host add: A is edited and backed up, B and its prior backup stay byte-identical', async () => {
    write(A, codexWith('alpha'))
    write(B, cursorWith('alpha'))
    write(`${B}.bak`, 'prior synthetic backup\n')
    const row = await rowNamed('alpha')
    const added: Added[] = []

    await moveAgentMcpServer(
      host(),
      row.key,
      recordingAdd(added, () => reached.delete('cursor')),
      row.removesFrom
    )

    expect(added).toEqual([{ name: 'alpha', keepsCopies: false }])
    expect(spy.removalPaths).toEqual([at(A)])
    expect(read(`${A}.bak`)).toBe(codexWith('alpha'))
    expect([read(B), read(`${B}.bak`)]).toEqual([cursorWith('alpha'), 'prior synthetic backup\n'])
  })

  it('request bounds: omitted agents uses fresh reach, [] removes nothing, a subset limits the row', async () => {
    const seed = () => {
      write(A, codexWith('alpha'))
      write(B, cursorWith('alpha'))
      spy.removalPaths = []
    }
    seed()
    await moveAgentMcpServer(host(), (await rowNamed('alpha')).key, recordingAdd([]))
    expect(spy.removalPaths).toEqual([at(A), at(B)])

    seed()
    const none: Added[] = []
    await moveAgentMcpServer(host(), (await rowNamed('alpha')).key, recordingAdd(none), [])
    expect(none).toEqual([{ name: 'alpha', keepsCopies: true }])
    expect(spy.removalPaths).toEqual([])
    expect([read(A), read(B)]).toEqual([codexWith('alpha'), cursorWith('alpha')])

    seed()
    await moveAgentMcpServer(host(), (await rowNamed('alpha')).key, recordingAdd([]), ['codex'])
    expect(spy.removalPaths).toEqual([at(A)])
    expect(read(B)).toBe(cursorWith('alpha'))
  })

  it('error after publication: the host entry stays, earlier edits stay, nothing is rolled back', async () => {
    write(A, codexWith('alpha'))
    write(B, cursorWith('alpha'))
    const row = await rowNamed('alpha')
    const added: Added[] = []
    // The user edits B's entry after Orca listed it and while the host entry is being saved.
    const edited = cursorWith('alpha').replace(ALPHA, 'https://alpha.example.test/other')

    const moved = moveAgentMcpServer(
      host(),
      row.key,
      recordingAdd(added, () => write(B, edited)),
      row.removesFrom
    )

    await expect(moved).rejects.toBeInstanceOf(AgentMcpConfigEditError)
    expect(added).toEqual([{ name: 'alpha', keepsCopies: false }])
    expect(read(A)).not.toContain('[mcp_servers.alpha]')
    expect(read(`${A}.bak`)).toBe(codexWith('alpha'))
    expect(read(B)).toBe(edited)
    expect(existsSync(at(`${B}.bak`))).toBe(false)
  })

  it('backup failure: a file whose backup can’t be written is not edited', async () => {
    write(A, codexWith('alpha'))
    write(`${A}.bak`, 'prior synthetic backup\n')
    const row = await rowNamed('alpha')
    spy.failBackupOf = A

    await expect(moveAgentMcpServer(host(), row.key, recordingAdd([]), ['codex'])).rejects.toThrow(
      'no space left on device'
    )

    expect(read(A)).toBe(codexWith('alpha'))
    expect(read(`${A}.bak`)).toBe('prior synthetic backup\n')
  })
})

describe('Move all: "one at a time … for each server it reaches"', () => {
  it('each row removes only its own confirmed agents, and a shared file’s second .bak is the intermediate bytes', async () => {
    // Listed: alpha only in A; beta in A and B. The batch dialog names the union A/B.
    write(A, codexWith('alpha', 'beta'))
    write(B, cursorWith('beta'))
    const alpha = await rowNamed('alpha')
    const beta = await rowNamed('beta')
    expect([alpha.removesFrom, beta.removesFrom]).toEqual([['codex'], ['codex', 'cursor']])

    // After the confirm and before row 1 re-reads: a same-definition alpha copy appears in B.
    write(B, cursorWith('beta', 'alpha'))
    const bBeforeRow2 = read(B)

    await moveAgentMcpServer(host(), alpha.key, recordingAdd([]), alpha.removesFrom)
    // Row-1 boundary: B and its backups are untouched although B now holds alpha too.
    expect(spy.removalPaths).toEqual([at(A)])
    expect(read(B)).toBe(bBeforeRow2)
    expect(existsSync(at(`${B}.bak`))).toBe(false)
    const intermediateA = read(A)
    expect(intermediateA).toBe(codexWith('beta'))
    expect(read(`${A}.bak`)).toBe(codexWith('alpha', 'beta'))

    await moveAgentMcpServer(host(), beta.key, recordingAdd([]), beta.removesFrom)
    // Positive control: row 2 edits and backs up B; A's rolling backup now holds row 1's result.
    expect(spy.removalPaths).toEqual([at(A), at(A), at(B)])
    expect(read(`${B}.bak`)).toBe(bBeforeRow2)
    expect(read(B)).toContain('"alpha"')
    expect(read(B)).not.toContain('"beta"')
    expect(Buffer.compare(readFileSync(at(`${A}.bak`)), Buffer.from(intermediateA))).toBe(0)
  })
})

describe('Move and a later consented agent-file sync', () => {
  it('Move’s backup is the pre-Move file; a later sync’s rewrite owns the next backup generation', async () => {
    // Host list with Cursor consent; a prior sync wrote Orca's entry beside the user's alpha.
    const folder = at('host-list')
    const userDataPath = at('orca-data')
    const sync = () =>
      syncMcpAgentFiles({
        folder,
        userDataPath,
        launcher: join(userDataPath, 'bin', 'orca'),
        context: { homeDir: home, env: {}, platform: 'darwin' },
        ledger: new McpAgentFileLedger(join(folder, '.orca', 'agent-files-ledger.json')),
        log: () => {}
      })
    write(B, cursorWith('alpha'))
    await addMcpServers(
      [{ name: 'postgres', command: 'npx', args: ['-y', 'postgres'] }],
      { nameGiven: true },
      folder
    )
    await setMcpAgentFileAllowed('cursor', true, folder)
    await sync()
    const afterPriorSync = read(B)
    expect(afterPriorSync).toMatch(/"postgres-orca-[0-9a-f]+"/)
    spy.removalPaths = []

    // Sync held (never run) for the whole Move: only Move's own edit reaches B.
    reached = new Set(['cursor'])
    const row = await rowNamed('alpha')
    await moveAgentMcpServer(host(), row.key, recordingAdd([]), row.removesFrom)
    expect(spy.removalPaths).toEqual([at(B)])
    const afterMove = read(B)
    expect(afterMove).not.toContain(ALPHA)
    expect(read(`${B}.bak`)).toBe(afterPriorSync)

    // Released: one attributed sync for a host-list change rewrites B and replaces the backup.
    await addMcpServers(
      [{ name: 'context7', command: 'npx', args: ['-y', 'context7'] }],
      { nameGiven: true },
      folder
    )
    await sync()
    expect(read(B)).toMatch(/"context7-orca-[0-9a-f]+"/)
    expect(read(`${B}.bak`)).toBe(afterMove)
    expect(existsSync(join(folder, '.orca', 'agent-files-ledger.json'))).toBe(true)
  })
})

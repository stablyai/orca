import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findCodexComputerUseHosts,
  inspectCodexComputerUseMappings
} from './codex-computer-use-runtime'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function runtime() {
  const root = await mkdtemp(join(tmpdir(), 'codex-cua-runtime-'))
  roots.push(root)
  const current = join(root, 'ChatGPT.app/Contents/Resources/cua_node/bin/node_repl').replaceAll(
    '\\',
    '/'
  )
  await mkdir(join(current, '..'), { recursive: true })
  await writeFile(current, 'current-runtime')
  return { root, current }
}

describe('Codex Computer Use executable mappings', () => {
  it('detects a deleted updater image despite an unchanged launch command', async () => {
    const { root, current } = await runtime()
    const hosts = [{ pid: 12, executable: current }]
    const mapped = join(
      root,
      'Sparkle/Installation/old/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl'
    ).replaceAll('\\', '/')
    expect(await inspectCodexComputerUseMappings(hosts, `p12\nftxt\nn${mapped}\n`)).toEqual({
      status: 'stale'
    })
  })

  it('recognizes the current executable and refuses missing replacement evidence', async () => {
    const { root, current } = await runtime()
    expect(
      await inspectCodexComputerUseMappings(
        [{ pid: 12, executable: current }],
        `p12\nn${current}\n`
      )
    ).toEqual({ status: 'current' })
    expect(
      await inspectCodexComputerUseMappings(
        [{ pid: 12, executable: join(root, 'missing') }],
        `p12\nn${current}\n`
      )
    ).toEqual({ status: 'unavailable' })
    expect(
      await inspectCodexComputerUseMappings(
        [{ pid: 12, executable: current }],
        `p99\nn${current}\n`
      )
    ).toEqual({ status: 'unavailable' })
  })

  it('detects replaced files even when both old and new images still exist', async () => {
    const { root, current } = await runtime()
    const old = join(root, 'node_repl').replaceAll('\\', '/')
    await writeFile(old, 'older-runtime')
    expect(
      await inspectCodexComputerUseMappings([{ pid: 12, executable: current }], `p12\nn${old}\n`)
    ).toEqual({ status: 'stale' })
  })

  it('keeps helper ownership within the outer Codex invocation', () => {
    const command = '/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl'
    const rows = [
      { pid: 1, ppid: 0, command: 'zsh' },
      { pid: 10, ppid: 1, command: 'codex --no-daemon' },
      { pid: 11, ppid: 10, command },
      { pid: 20, ppid: 10, command: 'codex exec child-task' },
      { pid: 21, ppid: 20, command },
      { pid: 30, ppid: 2, command }
    ]
    expect(findCodexComputerUseHosts(rows, 1)).toEqual([{ pid: 11, executable: command }])
    expect(
      findCodexComputerUseHosts(
        rows.filter((row) => row.pid !== 10),
        1
      )
    ).toEqual([])
  })
})

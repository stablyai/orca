import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { applyWindowsNodePtySettlement } from './ssh-relay-node-pty-windows-settlement.mjs'

const require = createRequire(import.meta.url)
const temporaryDirectories = []
const conptyDllKillSequence = `                this._ptyNative.kill(this._pty, this._useConptyDll);
                this._outSocket.on('data', function () {
                    _this._conoutSocketWorker.dispose();
                });`

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })))
})

async function createNodePtyFixture(source = conptyDllKillSequence) {
  const directory = await mkdtemp(join(tmpdir(), 'orca-node-pty-settlement-'))
  temporaryDirectories.push(directory)
  const agentPath = join(directory, 'windowsPtyAgent.js')
  await writeFile(agentPath, source)
  return { agentPath, directory }
}

describe('SSH relay copied node-pty Windows settlement', () => {
  it('starts ConPTY worker disposal before waiting for more output', async () => {
    const nodePtyDirectory = dirname(require.resolve('node-pty/package.json'))
    const fixture = await createNodePtyFixture(
      await readFile(join(nodePtyDirectory, 'lib', 'windowsPtyAgent.js'), 'utf8')
    )

    await applyWindowsNodePtySettlement({
      nodePtyLibraryDirectory: fixture.directory,
      tuple: 'win32-x64'
    })

    expect(await readFile(fixture.agentPath, 'utf8')).toContain(
      `                this._ptyNative.kill(this._pty, this._useConptyDll);
                // Why: quiet ConPTY output cannot retrigger disposal, so start its bounded drain now.
                this._conoutSocketWorker.dispose();
                this._outSocket.on('data', function () {
                    _this._conoutSocketWorker.dispose();
                });`
    )
  })

  it('does not inspect or modify a POSIX node-pty copy', async () => {
    const missingDirectory = join(tmpdir(), 'orca-node-pty-posix-does-not-exist')

    await expect(
      applyWindowsNodePtySettlement({
        nodePtyLibraryDirectory: missingDirectory,
        tuple: 'linux-x64-glibc'
      })
    ).resolves.toEqual({ applied: false })
  })

  it('rejects source drift without modifying the copied agent', async () => {
    const source = conptyDllKillSequence.replace(
      "this._outSocket.on('data'",
      "this._outSocket.once('data'"
    )
    const fixture = await createNodePtyFixture(source)

    await expect(
      applyWindowsNodePtySettlement({
        nodePtyLibraryDirectory: fixture.directory,
        tuple: 'win32-arm64'
      })
    ).rejects.toThrow('expected exactly one DLL-mode ConPTY worker settlement sequence; found 0')
    await expect(readFile(fixture.agentPath, 'utf8')).resolves.toBe(source)
  })

  it('rejects duplicate source matches without modifying the copied agent', async () => {
    const source = `${conptyDllKillSequence}\n${conptyDllKillSequence}`
    const fixture = await createNodePtyFixture(source)

    await expect(
      applyWindowsNodePtySettlement({
        nodePtyLibraryDirectory: fixture.directory,
        tuple: 'win32-x64'
      })
    ).rejects.toThrow('expected exactly one DLL-mode ConPTY worker settlement sequence; found 2')
    await expect(readFile(fixture.agentPath, 'utf8')).resolves.toBe(source)
  })

  it('is wired after node-pty is copied into exclusive artifact staging', async () => {
    const buildSource = await readFile(
      new URL('./ssh-relay-node-pty-build.mjs', import.meta.url),
      'utf8'
    )
    const copyIndex = buildSource.indexOf('await cp(sourceDirectory, buildDirectory')
    const settlementIndex = buildSource.indexOf('await applyWindowsNodePtySettlement({')

    expect(copyIndex).toBeGreaterThan(-1)
    expect(settlementIndex).toBeGreaterThan(copyIndex)
    expect(buildSource.slice(copyIndex, settlementIndex)).not.toContain('node-gyp')
  })
})

import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '@orca/process-host'
import type { PipedChildProcess, PipedProcessSpec } from '@orca/process-host/process-spec'
import { execCommand } from '../ssh/remote-exec/remote-exec-command'
import { createWslOrcadHostTransport, type WslOrcadHostTransport } from './wsl-orcad-host-transport'

const posix = process.platform !== 'win32'
const children: PipedChildProcess[] = []
const transports: WslOrcadHostTransport[] = []

/** Runs what follows `--exec` with the local sh, as wsl.exe would inside the distro. */
function localTransport() {
  const specs: PipedProcessSpec[] = []
  const transport = createWslOrcadHostTransport({
    target: {
      kind: 'wsl',
      id: 'env-1',
      distro: 'Ubuntu-24.04',
      label: 'Ubuntu'
    },
    spawn: (spec) => {
      specs.push(spec)
      const args = spec.args ?? []
      const child = spawnProcess({
        program: 'sh',
        args: args.slice(args.indexOf('--exec') + 2)
      })
      children.push(child)
      return child
    }
  })
  transports.push(transport)
  return { transport, specs }
}

afterEach(() => {
  transports.splice(0).forEach((transport) => transport.dispose())
  children.splice(0).forEach((child) => child.kill())
})

describe.runIf(posix)('WSL transport command loops', () => {
  it('runs a sequence of stdin-free probes over one wsl.exe', async () => {
    const { transport, specs } = localTransport()
    for (const word of ['uname', 'home', 'record', 'fence']) {
      expect(await execCommand(transport, `echo ${word}`)).toBe(`${word}\n`)
    }
    expect(specs).toHaveLength(1)
    expect(specs[0]?.args?.slice(0, 5)).toEqual(['-d', 'Ubuntu-24.04', '--exec', 'sh', '-c'])
    expect(specs[0]?.args?.[6]).toBe('orca-wsl-exec-loop')
  })

  it('still gives a command that takes stdin its own wsl.exe', async () => {
    const { transport, specs } = localTransport()
    await execCommand(transport, 'echo first')
    expect(
      await execCommand(transport, 'cat', {
        stdin: Readable.from([Buffer.from('piped')])
      })
    ).toBe('piped')
    expect(specs).toHaveLength(2)
    expect(specs[1]?.args).toEqual(['-d', 'Ubuntu-24.04', '--exec', 'sh', '-c', expect.any(String)])
    expect(specs[1]?.args?.[5]).toContain('cat')
  })

  it('falls back to one wsl.exe per command when the loop cannot start', async () => {
    const specs: PipedProcessSpec[] = []
    const transport = createWslOrcadHostTransport({
      target: {
        kind: 'wsl',
        id: 'env-1',
        distro: 'Ubuntu-24.04',
        label: 'Ubuntu'
      },
      spawn: (spec) => {
        specs.push(spec)
        const args = spec.args ?? []
        const shellArgs = args.slice(args.indexOf('--exec') + 2)
        // A guest without base64: the loop's self-test fails and it exits.
        const child = spawnProcess({
          program: 'sh',
          args: shellArgs[2] === 'orca-wsl-exec-loop' ? ['-c', 'exit 98'] : shellArgs
        })
        children.push(child)
        return child
      }
    })
    transports.push(transport)
    expect(await execCommand(transport, 'echo a')).toBe('a\n')
    expect(await execCommand(transport, 'echo b')).toBe('b\n')
    expect(specs).toHaveLength(3)
  })
})

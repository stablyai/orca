// `bots.github.people` as the host serves it: a Windows host answers exact-only before any read is
// admitted; elsewhere every request in the process shares one admitted read, whatever its scope,
// timing or outcome. This is about logical reads only, not OS processes. Synthetic data only.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BOT_GITHUB_METHODS } from './bots-github'

const gh = vi.hoisted(() => ({ run: vi.fn<(args: string[]) => Promise<{ stdout: string }>>() }))
vi.mock(import('../../../git/command-runner/hosted-cli/gh-exec-file'), async (original) => ({
  ...(await original()),
  ghExecFileAsync: gh.run as never
}))

const repos = (...names: string[]) => ({ repositories: names, owners: [], more: false })
const realPlatform = process.platform
const onPlatform = (platform: NodeJS.Platform): void => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

// One import for the file: the host process keeps one shared read in this module.
function people() {
  const method = BOT_GITHUB_METHODS.find((entry) => entry.name === 'bots.github.people')
  if (!method) {
    throw new Error('bots.github.people is not registered')
  }
  return (scope: ReturnType<typeof repos>) =>
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this handler reads only its params.
    method.handler({ scope, owner: 'owner-one' }, {} as never)
}

afterEach(() => {
  onPlatform(realPlatform)
  gh.run.mockReset()
})

describe('the people list request elsewhere', () => {
  it('shares one admitted read across concurrent requests, a changed scope and a failure', async () => {
    onPlatform('linux')
    let finish = (_value: { stdout: string }): void => {}
    gh.run.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const ask = people()
    const first = ask(repos('acme/web'))
    const concurrent = ask(repos('acme/api'))
    finish({ stdout: '' })
    expect(await first).toEqual({ ok: true, value: { status: 'unavailable', spent: true } })
    expect(await concurrent).toEqual({ ok: true, value: { status: 'unavailable', spent: true } })
    // After that failure, a later request for yet another scope is not admitted either.
    expect(await ask(repos('acme/docs'))).toEqual({
      ok: true,
      value: { status: 'unavailable', spent: true }
    })
    expect(gh.run).toHaveBeenCalledOnce()
  })
})

describe('the people list request on a Windows host', () => {
  // After a read was admitted in this process too: the guard comes before the latch.
  it('answers exact-only without admitting a read or reaching gh', async () => {
    onPlatform('win32')
    const ask = people()
    expect(await ask(repos('acme/web'))).toEqual({ ok: true, value: { status: 'exact-only' } })
    expect(await ask(repos('acme/api'))).toEqual({ ok: true, value: { status: 'exact-only' } })
    expect(gh.run).not.toHaveBeenCalled()
  })
})

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { agentSessionAccountHome } from '../../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import { PI_RPC_AGENT } from '../../rpc-agent-definition'
import { createPiModelCatalogProbe } from './rpc-model-catalog-probe'

it('re-stamps the Pi catalog when models, settings, or signed-in providers change', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-pi-catalog-stamp-'))
  try {
    const executable = join(root, process.platform === 'win32' ? 'pi.cmd' : 'pi')
    await writeFile(executable, '', { mode: 0o755 })
    const accountDir = join(root, 'agent')
    const models = join(accountDir, 'models.json')
    const settings = join(accountDir, 'settings.json')
    const auth = join(accountDir, 'auth.json')
    await mkdir(accountDir)
    await writeFile(models, '{"providers":{}}')
    await writeFile(settings, '{"defaultModel":"a"}')
    const probe = createPiModelCatalogProbe({
      resolveEnvironment: async () => ({ PATH: root }),
      resolveCommand: () => executable,
      homePath: root
    })
    const stamp = async () =>
      (await probe.resolve?.(agentSessionAccountHome(PI_RPC_AGENT, accountDir), '', 'snapshot'))
        ?.inputStamp

    const initial = await stamp()
    await writeFile(models, '{"providers":{}}')
    // Pi creates an empty auth.json on first run; the probe must not expire its own listing.
    await writeFile(auth, '{}')
    expect(await stamp()).toBe(initial)

    await writeFile(auth, '{"anthropic":{"type":"oauth","access":"1"}}')
    const signedIn = await stamp()
    expect(signedIn).not.toBe(initial)
    // Pi refreshes OAuth tokens in auth.json on its own; that churn must not relist.
    await writeFile(auth, '{"anthropic":{"type":"oauth","access":"2"}}')
    expect(await stamp()).toBe(signedIn)
    await writeFile(auth, '\uFEFF{"anthropic":{"type":"oauth","access":"3"}}')
    expect(await stamp()).toBe(signedIn)
    await writeFile(auth, '{}')
    expect(await stamp()).toBe(initial)

    await writeFile(models, '{"providers":{"local":{}}}')
    const afterModels = await stamp()
    expect(afterModels).not.toBe(initial)

    await writeFile(settings, '{"defaultModel":"b"}')
    expect(await stamp()).not.toBe(afterModels)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

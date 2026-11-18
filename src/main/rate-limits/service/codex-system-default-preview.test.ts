import { expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexSystemDefaultUsagePreview } from '../providers/codex/codex-system-default-usage-preview'

it('pins a System default preview to the credentials read for its identity, even after the source login changes', async () => {
  const home = await mkdtemp(join(tmpdir(), 'orca-default-preview-'))
  try {
    const original =
      '{"tokens":{"access_token":"personal-token","account_id":"personal","id_token":"e30.eyJlbWFpbCI6InBlcnNvbmFsQGV4YW1wbGUudGVzdCJ9.sig"},"email":"personal@example.test"}'
    await writeFile(join(home, 'auth.json'), original)
    const preview = codexSystemDefaultUsagePreview(
      'work',
      {
        hasAuth: true,
        authKind: 'oauth',
        email: 'personal@example.test',
        providerAccountId: 'personal',
        workspaceLabel: null
      },
      home
    )!
    const selected = await preview.resolveHome()
    await writeFile(
      join(home, 'auth.json'),
      '{"tokens":{"access_token":"work-token","account_id":"work"},"email":"work@example.test"}'
    )
    expect(selected).toEqual({ kind: 'ready', managedHomePath: home, authSnapshot: original })
    expect(await preview.resolveHome()).toEqual({ kind: 'skip' })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

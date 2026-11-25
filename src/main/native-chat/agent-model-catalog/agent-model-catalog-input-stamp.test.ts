import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { expect, it } from 'vitest'
import { agentModelCatalogInputStamp } from './agent-model-catalog-input-stamp'

it('invalidates the catalog stamp when the runnable CLI behind a same-named directory changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'orca-catalog-path-'))
  try {
    const command = 'fixture-agent'
    const windows = process.platform === 'win32'
    const fileName = windows ? `${command}.cmd` : command
    const firstBin = join(root, 'first')
    const secondBin = join(root, 'second')
    const executable = join(secondBin, fileName)
    await mkdir(join(firstBin, fileName), { recursive: true })
    await mkdir(secondBin)
    await writeFile(executable, windows ? '@echo v1\r\n' : '#!/bin/sh\necho v1\n', { mode: 0o755 })

    const input = { command, cwd: root, env: { PATH: [firstBin, secondBin].join(delimiter) } }
    const previous = await agentModelCatalogInputStamp(input)
    await writeFile(executable, windows ? '@echo v2-updated\r\n' : '#!/bin/sh\necho v2-updated\n')

    const updated = await agentModelCatalogInputStamp(input)
    expect(updated).not.toBe(previous)
    expect(updated).toBe(await agentModelCatalogInputStamp({ ...input, command: executable }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

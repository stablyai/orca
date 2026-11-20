import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { refreshManagedScriptIfPresent } from './managed-hook-script-refresh'
import { writeManagedScript } from './managed-hook-script-write'

describe('managed hook form marker', () => {
  let dir = ''
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-hook-form-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('marks written scripts and never overwrites one from a newer build', async () => {
    const script = join(dir, 'cursor-hook.sh')
    writeManagedScript(script, '#!/bin/sh\necho old\n')
    expect(await readFile(script, 'utf8')).toBe('#!/bin/sh\n# orca-agent-hook-form=1\necho old\n')

    const newer = '#!/bin/sh\n# orca-agent-hook-form=99\necho newer\n'
    await writeFile(script, newer)
    writeManagedScript(script, '#!/bin/sh\necho old\n')
    await refreshManagedScriptIfPresent(script, '#!/bin/sh\necho old\n')
    expect(await readFile(script, 'utf8')).toBe(newer)
  })
})

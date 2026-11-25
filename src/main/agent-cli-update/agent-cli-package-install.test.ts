import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { packageShimTarget } from './agent-cli-package-install'

// The tail of the POSIX shim pnpm 11 writes for a global bin.
const PNPM_SHIM = `#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\\\,/,g')")
if [ -x "$basedir/node" ]; then
  exec "$basedir/node"  "$basedir/../global/v11/13aa9-1a2/node_modules/@qwen-code/qwen-code/cli.js" "$@"
else
  exec node  "$basedir/../global/v11/13aa9-1a2/node_modules/@qwen-code/qwen-code/cli.js" "$@"
fi
# cmd-shim-target=/Users/a/Library/pnpm/global/v11/13aa9-1a2/node_modules/@qwen-code/qwen-code/cli.js
`

let folder = ''

afterEach(() => rm(folder, { recursive: true, force: true }))

async function launcher(contents: string): Promise<string> {
  folder = await mkdtemp(join(tmpdir(), 'agent-cli-shim-'))
  const path = join(folder, 'qwen')
  await writeFile(path, contents)
  return path
}

describe('packageShimTarget', () => {
  it('reads the package file a pnpm shim runs', async () => {
    expect(await packageShimTarget(await launcher(PNPM_SHIM))).toBe(
      '/Users/a/Library/pnpm/global/v11/13aa9-1a2/node_modules/@qwen-code/qwen-code/cli.js'
    )
  })
})

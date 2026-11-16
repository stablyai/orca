import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')(
  'runs the generated POSIX example with the owning managed CLI name and quoted arguments',
  async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { runProcessSync } = await import('@orca/process-host')
    const { projectGroupSetupExample } =
      await import('../../../../../shared/project/groups/project-group-setup-example')
    const root = mkdtempSync(join(tmpdir(), 'orca-group-cli-example-'))
    const cli = join(root, 'managed cli')
    const receipt = join(root, 'arguments')
    try {
      writeFileSync(cli, '#!/bin/bash\nprintf "%s\\n" "$@" > "$CLI_RECEIPT"\n', { mode: 0o755 })
      const result = runProcessSync({
        program: 'bash',
        args: [
          '-c',
          projectGroupSetupExample([{ id: 'repo-id', displayName: 'Services' }], 'linux')
        ],
        env: {
          ...process.env,
          ORCA_CLI_COMMAND: cli,
          ORCA_WORKSPACE_NAME: 'task & spaced',
          CLI_RECEIPT: receipt
        }
      })
      expect(result.code).toBe(0)
      expect(readFileSync(receipt, 'utf8')).toBe(
        'worktree\ncreate\n--repo\nid:repo-id\n--name\ntask & spaced\n--json\n'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

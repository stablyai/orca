import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { windowsPowerShellPath } from '../../shared/child-process/windows-system-binary'
import { parseOrchestrationTaskDepsFlag } from '../runtime/orchestration/task-deps-flag'

const PARENT_TASK_ID = 'task_b2a580db74d8'

describe('native CLI PowerShell argv boundary', () => {
  it.skipIf(process.platform !== 'win32')(
    'recovers ConvertTo-Json dependencies after PowerShell 5.1 builds native argv',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-native-powershell-argv-'))
      const scriptPath = join(root, 'invoke-deps.ps1')
      const targetPath = join(root, 'argv-target.cjs')

      try {
        await writeFile(
          scriptPath,
          [
            `$deps = ConvertTo-Json -Compress @('${PARENT_TASK_ID}')`,
            '& $args[0] $args[1] --deps $deps',
            'exit $LASTEXITCODE'
          ].join('\n'),
          'utf8'
        )
        await writeFile(
          targetPath,
          'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n',
          'utf8'
        )

        const result = await runProcess({
          program: windowsPowerShellPath(),
          args: [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath,
            process.execPath,
            targetPath
          ]
        })

        expect(result.code).toBe(0)
        expect(result.stderr).toBe('')
        const argv = JSON.parse(result.stdout.trim()) as string[]
        expect(argv[0]).toBe('--deps')
        expect(argv[1]).toBe(`[${PARENT_TASK_ID}]`)
        expect(parseOrchestrationTaskDepsFlag(argv[1])).toEqual([PARENT_TASK_ID])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})

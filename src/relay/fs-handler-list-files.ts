/**
 * Ripgrep-based file listing for Quick Open.
 * Extracted from fs-handler-utils.ts to keep it under 300 lines (oxlint max-lines).
 */
import { spawn } from 'child_process'
import { buildRgArgsForQuickOpen, normalizeQuickOpenRgLine } from '../shared/quick-open-filter'

export const LIST_FILES_TIMEOUT_MS = 25_000

export function listFilesWithRg(
  rootPath: string,
  excludePathPrefixes: readonly string[] = []
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const files = new Set<string>()
    let done = false

    const { primary, envPass } = buildRgArgsForQuickOpen({
      searchRoot: rootPath,
      excludePathPrefixes,
      forceSlashSeparator: true
    })

    const runPass = (args: string[], name: string) =>
      new Promise<void>((passResolve, passReject) => {
        const child = spawn('rg', args, {
          cwd: rootPath,
          stdio: ['ignore', 'pipe', 'pipe']
        })

        let passBuf = ''
        const processLine = (line: string) => {
          const normalized = normalizeQuickOpenRgLine(line, {
            type: 'absolute',
            rootPath
          })
          if (normalized) {
            files.add(normalized)
          }
        }

        child.stdout.on('data', (chunk: Buffer) => {
          passBuf += chunk.toString('utf-8')
          const lines = passBuf.split('\n')
          passBuf = lines.pop() || ''
          for (const line of lines) {
            processLine(line)
          }
        })

        const timer = setTimeout(() => {
          child.kill('SIGTERM')
          passReject(new Error(`${name} pass timed out after ${LIST_FILES_TIMEOUT_MS}ms`))
        }, LIST_FILES_TIMEOUT_MS)

        child.on('error', (err) => {
          clearTimeout(timer)
          passReject(err)
        })

        child.once('close', (code, signal) => {
          clearTimeout(timer)
          if (done) {
            return
          }
          if (signal) {
            passBuf = ''
            passReject(new Error(`rg killed by ${signal}`))
            return
          }
          if (passBuf) {
            processLine(passBuf)
          }
          if (code === 0 || code === 1 || code === 2) {
            passResolve()
          } else {
            passReject(new Error(`rg exited with code ${code}`))
          }
        })
      })

    Promise.all([runPass(primary, 'primary'), runPass(envPass, 'envPass')])
      .then(() => {
        if (done) {
          return
        }
        done = true
        resolve(Array.from(files))
      })
      .catch((err) => {
        if (done) {
          return
        }
        done = true
        reject(err instanceof Error ? err : new Error(String(err)))
      })
  })
}

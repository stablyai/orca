import type { ChildProcess } from 'child_process'
import { createUniqueQuickOpenBasenameCollector } from '../../shared/quick-open-unique-basename'

export type BasenameProcessPassConfig = {
  delimiter: '\0' | '\n'
  spawnPass: (args: string[]) => ChildProcess
  passArgs: string[][]
  parsePath: (rawPath: string) => string | null
  timeoutMs: number
  acceptsExit: (code: number | null, parseablePathCount: number) => boolean
}

export function resolveBasenameFromProcessPasses(
  basename: string,
  excludePathPrefixes: readonly string[],
  config: BasenameProcessPassConfig
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const collector = createUniqueQuickOpenBasenameCollector(basename, excludePathPrefixes)
    const children: ChildProcess[] = []
    const cleanups: (() => void)[] = []
    let settled = false
    let completedPasses = 0

    const finish = (result: string | null): void => {
      if (settled) {
        return
      }
      settled = true
      for (const cleanup of cleanups) {
        cleanup()
      }
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
        }
      }
      resolve(result)
    }

    const fail = (error: Error): void => {
      if (settled) {
        return
      }
      settled = true
      for (const cleanup of cleanups) {
        cleanup()
      }
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill()
        }
      }
      reject(error)
    }

    for (const args of config.passArgs) {
      const child = config.spawnPass(args)
      children.push(child)
      let buffer = ''
      let done = false
      let parseablePathCount = 0
      let timer: ReturnType<typeof setTimeout> | null = null

      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        child.stdout?.off('data', handleStdoutData)
        child.stderr?.off('data', handleStderrData)
        child.off('error', handleError)
        child.off('close', handleClose)
      }
      cleanups.push(cleanup)

      const resolvePass = (): void => {
        if (done || settled) {
          return
        }
        done = true
        cleanup()
        completedPasses += 1
        if (completedPasses === config.passArgs.length) {
          finish(collector.result())
        }
      }

      const rejectPass = (error: Error): void => {
        if (done || settled) {
          return
        }
        done = true
        cleanup()
        fail(error)
      }

      const processPath = (rawPath: string): void => {
        const relativePath = config.parsePath(rawPath)
        if (relativePath === null) {
          return
        }
        parseablePathCount += 1
        if (collector.add(relativePath)) {
          finish(null)
        }
      }

      function handleStdoutData(chunk: string): void {
        buffer += chunk
        let start = 0
        let index = buffer.indexOf(config.delimiter, start)
        while (index !== -1) {
          processPath(buffer.substring(start, index))
          if (settled) {
            return
          }
          start = index + 1
          index = buffer.indexOf(config.delimiter, start)
        }
        buffer = start < buffer.length ? buffer.substring(start) : ''
      }

      function handleStderrData(): void {
        /* drain */
      }

      function handleError(error: Error): void {
        rejectPass(error)
      }

      function handleClose(code: number | null, signal: NodeJS.Signals | null): void {
        if (signal) {
          rejectPass(new Error(`basename scan killed by ${signal}`))
          return
        }
        if (buffer) {
          processPath(buffer)
        }
        if (settled) {
          return
        }
        if (config.acceptsExit(code, parseablePathCount)) {
          resolvePass()
        } else {
          rejectPass(new Error(`basename scan exited with code ${code}`))
        }
      }

      child.stdout?.setEncoding('utf-8')
      child.stdout?.on('data', handleStdoutData)
      child.stderr?.on('data', handleStderrData)
      child.once('error', handleError)
      child.once('close', handleClose)
      timer = setTimeout(() => {
        buffer = ''
        child.kill()
        rejectPass(new Error('basename scan timed out'))
      }, config.timeoutMs)
    }
  })
}

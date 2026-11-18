import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { Worker, workerData } from 'node:worker_threads'

// Run unbuilt production TS in Node workers, including extensionless source imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      if (
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.') &&
        !path.extname(specifier)
      ) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  }
})

if (workerData?.blockedDirectory) {
  const originalOpen = fsp.opendir
  fsp.opendir = (directory, options) =>
    directory === workerData.blockedDirectory
      ? new Promise(() => {})
      : originalOpen.call(fsp, directory, options)
  syncBuiltinESMExports()
}

if (workerData?.unknownDirectory) {
  const { dir, names, counters: buffer, holdMetadata } = workerData.unknownDirectory
  const counters = new Int32Array(buffer)
  const originalOpen = fsp.opendir
  const originalLstat = fs.lstatSync
  fs.lstatSync = function (candidate, ...args) {
    if (path.dirname(String(candidate)) === dir) {
      Atomics.add(counters, 0, 1)
      if (holdMetadata) {
        Atomics.store(counters, 3, 1)
        Atomics.wait(counters, 4, 0)
      }
    }
    return originalLstat.call(fs, candidate, ...args)
  }
  fsp.opendir = async function (directory, options) {
    if (directory !== dir) {
      return originalOpen.call(fsp, directory, options)
    }
    let offset = 0
    // Supply native UV_DIRENT_UNKNOWN records; leave Node's actual fs.Dir conversion intact.
    return new fs.Dir(
      {
        read(_encoding, size, req) {
          Atomics.add(counters, 1, 1)
          const result =
            offset === names.length
              ? null
              : names.slice(offset, offset + size).flatMap((name) => [name, 0])
          offset = Math.min(offset + size, names.length)
          setImmediate(() => req.oncomplete(null, result))
        },
        close(req) {
          Atomics.add(counters, 2, 1)
          if (req) {
            setImmediate(() => req.oncomplete(null))
          }
        }
      },
      directory,
      options
    )
  }
  syncBuiltinESMExports()
}

if (workerData) {
  await import(workerData.entry)
} else {
  const { transformSync } = await import('esbuild')
  registerHooks({
    load(url, context, nextLoad) {
      if (url.endsWith('.ts')) {
        return {
          format: 'module',
          source: transformSync(fs.readFileSync(new URL(url), 'utf8'), {
            loader: 'ts',
            format: 'esm',
            target: 'esnext'
          }).code,
          shortCircuit: true
        }
      }
      return nextLoad(url, context)
    }
  })
  const { DetectionDirectoryWorkerClient } =
    await import('./command-path-directory-worker-client.ts')
  const client = new DetectionDirectoryWorkerClient(
    () =>
      new Worker(new URL(import.meta.url), {
        workerData: {
          entry: new URL('./command-path-directory-worker-entry.ts', import.meta.url).href
        }
      })
  )
  void client.read(process.argv[2]).then((names) => {
    console.log(JSON.stringify(names === null ? null : [...names]))
  })
}

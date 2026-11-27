import { basename } from 'node:path'

// Set __zod_globalConfig.jitless in banner: module-scope schema construction probes eval before our imports can configure it, generating caught-but-reported CSP violations.
const ZOD_JITLESS_BANNER =
  'globalThis.__zod_globalConfig ??= {}; globalThis.__zod_globalConfig.jitless = true;'

// RN and Expo modules read process.env at module scope, before any of our code runs.
export const PAGE_GLOBALS_BANNER = `globalThis.process ??= { env: { NODE_ENV: 'production', EXPO_OS: 'web' }, platform: 'web', version: '', nextTick: (fn) => setTimeout(fn, 0) };${ZOD_JITLESS_BANNER}`

// A chunk's static imports run before it, so the first script to run imports nothing; once its banner
// sets the globals, every later script sees them. esbuild prints the banner on every chunk.
export function bannerOnlyWhereScriptsRunFirst(metafile, outputFiles) {
  const prefix = Buffer.from(`${PAGE_GLOBALS_BANNER}\n`, 'utf8')
  const importing = new Set(
    Object.entries(metafile.outputs)
      .filter(([, { imports }]) => imports.some(({ kind }) => kind === 'import-statement'))
      .map(([output]) => basename(output))
  )
  return outputFiles.map((file) => {
    const contents = Buffer.from(file.contents)
    if (!importing.has(basename(file.path))) {
      return file
    }
    if (!contents.subarray(0, prefix.length).equals(prefix)) {
      throw new Error(
        `[build-mobile-web-app-bundle] ${basename(file.path)} does not start with the banner`
      )
    }
    return { path: file.path, contents: contents.subarray(prefix.length) }
  })
}

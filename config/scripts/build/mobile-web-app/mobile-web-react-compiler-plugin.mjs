import { readFile } from 'node:fs/promises'
import { join, normalize, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transform } from 'oxc-transform-react'
// Matches the desktop renderer's REACT_COMPILER_OPTIONS (config/build-plugins/react-compiler.ts).
const REACT_COMPILER_OPTIONS = { target: '19' }

const mobileDir = fileURLToPath(new URL('../../../../mobile', import.meta.url))
const normalizeForCompare = (file) =>
  process.platform === 'win32' ? normalize(file).toLowerCase() : normalize(file)

export const REACT_COMPILER_PLUGIN_NAME = 'mobile-react-compiler'
const SOURCE_ROOTS = ['app', 'src', 'web-entry'].map(
  (dir) => normalizeForCompare(join(mobileDir, dir)) + sep
)

// The app's own components and hooks; packages ship compiled or are left alone, as on native.
export function isMobileReactCompilerSource(file) {
  const normalized = normalizeForCompare(file)
  return (
    SOURCE_ROOTS.some((root) => normalized.startsWith(root)) &&
    !normalized.includes(`${sep}node_modules${sep}`) &&
    !normalized.includes('.generated.')
  )
}

// Metro compiles the app with React Compiler (app.json experiments.reactCompiler); the page must too.
export const reactCompilerShim = {
  name: 'react-compiler',
  appliesTo: (options) =>
    process.env.ORCA_REACT_COMPILER === '0' ||
    options.plugins?.some((plugin) => plugin.name === REACT_COMPILER_PLUGIN_NAME) === true
}

// Same compiler as the Metro build (app.json experiments.reactCompiler), so the page memoizes alike.
export const mobileReactCompilerPlugin = {
  name: REACT_COMPILER_PLUGIN_NAME,
  setup(build) {
    if (process.env.ORCA_REACT_COMPILER === '0') {
      return
    }
    build.onLoad({ filter: /\.tsx?$/ }, async (args) => {
      if (!isMobileReactCompilerSource(args.path)) {
        return undefined
      }
      const source = await readFile(args.path, 'utf8')
      const lang = args.path.endsWith('.tsx') ? 'tsx' : 'ts'
      const result = await transform(args.path, source, {
        lang,
        sourceType: 'module',
        jsx: 'preserve',
        reactCompiler: REACT_COMPILER_OPTIONS
      })
      if (result.fatal || result.errors.some((error) => error.severity === 'Error')) {
        return { errors: result.errors.map((error) => ({ text: error.message })) }
      }
      return { contents: result.code, loader: lang === 'tsx' ? 'jsx' : 'js' }
    })
  }
}

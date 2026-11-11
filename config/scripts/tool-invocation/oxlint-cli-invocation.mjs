import process from 'node:process'
import { resolveOxcCliInvocation } from './oxc-cli-invocation.mjs'

export function resolveOxlintInvocation(root = process.cwd()) {
  return resolveOxcCliInvocation('oxlint', 'oxlint', root)
}

export function parseOxlintOutput(stdout, label) {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end === -1) {
    throw new Error(`${label} did not return Oxlint JSON output.`)
  }
  return JSON.parse(stdout.slice(start, end + 1))
}

import process from 'node:process'
import { resolveOxcCliInvocation } from './oxc-cli-invocation.mjs'

export function resolveOxlintInvocation(root = process.cwd()) {
  return resolveOxcCliInvocation('oxlint', 'oxlint', root)
}

import { parseOrcaYamlWithParser } from '../shared/orca-yaml-parser'
import { isOrcaYamlTextWithinLimit } from '../shared/orca-yaml-file-limit'
import type { OrcaHooks } from '../shared/orca-yaml-hook-types'
import { loadYaml } from './yaml-loader'

export function parseOrcaYaml(content: string): OrcaHooks | null {
  if (!isOrcaYamlTextWithinLimit(content)) {
    return null
  }
  return parseOrcaYamlWithParser(content, loadYaml())
}

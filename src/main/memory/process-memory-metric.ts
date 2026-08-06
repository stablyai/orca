import os from 'node:os'
import type { ProcessMemoryMetric } from '../../shared/types'

export function getProcessMemoryMetric(
  platform: NodeJS.Platform = os.platform()
): ProcessMemoryMetric {
  return platform === 'win32' ? 'working-set' : 'rss'
}

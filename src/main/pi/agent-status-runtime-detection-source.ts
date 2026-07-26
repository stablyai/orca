import type { PiAgentKind } from '../../shared/pi-agent-kind'

export function getPiAgentStatusRuntimeDetectionSourceLines(kind: PiAgentKind): string[] {
  return [
    'function processName(value: unknown): string {',
    "  return String(value || '').split(/[\\\\/]/).pop()?.toLowerCase() || ''",
    '}',
    '',
    `const CONFIGURED_HOOK_PATH = '/hook/${kind}'`,
    'let cachedOmpRuntime: boolean | null = null',
    '',
    'function isOmpRuntime(): boolean {',
    '  if (cachedOmpRuntime !== null) return cachedOmpRuntime',
    "  if (CONFIGURED_HOOK_PATH === '/hook/omp') {",
    '    cachedOmpRuntime = true',
    '    return true',
    '  }',
    '  const executableNames = [',
    '    processName(process.title),',
    '    processName(process.env._),',
    '    processName(process.argv[1]),',
    '    processName(process.argv[0])',
    '  ]',
    '  cachedOmpRuntime = executableNames.some((name) =>',
    "    ['omp', 'omp.js', 'omp.sh', 'omp.cmd', 'omp.exe', 'omp.bat'].includes(name)",
    '  )',
    '  return cachedOmpRuntime',
    '}',
    '',
    'function resolveHookPath(ompRuntime: boolean): string {',
    '  // Why: runtime detection keeps a bare-shell OMP launch from reporting as Pi.',
    "  if (ompRuntime) return '/hook/omp'",
    '  return CONFIGURED_HOOK_PATH',
    '}'
  ]
}

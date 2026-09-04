import type { PiAgentKind } from '../../shared/pi-agent-kind'

export function getPiAgentOmpRuntimeDetectionSourceLines(configuredOmp: boolean): string[] {
  return [
    `const CONFIGURED_OMP_RUNTIME = ${configuredOmp}`,
    '',
    'function processName(value: unknown): string {',
    "  return String(value || '').split(/[\\\\/]/).pop()?.toLowerCase() || ''",
    '}',
    '',
    'let cachedOmpRuntime: boolean | null = null',
    '',
    'function isOmpRuntime(): boolean {',
    '  if (cachedOmpRuntime !== null) return cachedOmpRuntime',
    '  if (CONFIGURED_OMP_RUNTIME) {',
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
    '}'
  ]
}

export function getPiAgentStatusRuntimeDetectionSourceLines(kind: PiAgentKind): string[] {
  if (kind === 'prime-agent') {
    return [
      `const CONFIGURED_HOOK_PATH = '/hook/${kind}'`,
      '',
      'function isOmpRuntime(): boolean {',
      '  return false',
      '}',
      '',
      'function resolveHookPath(_ompRuntime: boolean): string {',
      '  return CONFIGURED_HOOK_PATH',
      '}'
    ]
  }

  return [
    `const CONFIGURED_HOOK_PATH = '/hook/${kind}'`,
    '',
    ...getPiAgentOmpRuntimeDetectionSourceLines(kind === 'omp'),
    '',
    'function resolveHookPath(ompRuntime: boolean): string {',
    '  // Why: runtime detection keeps a bare-shell OMP launch from reporting as Pi.',
    "  if (ompRuntime) return '/hook/omp'",
    '  return CONFIGURED_HOOK_PATH',
    '}'
  ]
}

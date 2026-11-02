import type { PiAgentKind } from '../../shared/pi-agent-kind'

/** Bare-shell OMP can run inside a Pi-kind pane; every approval-aware extension needs runtime detection. */
export function getPiOmpRuntimeDetectionSourceLines(configuredHookPath: string): string[] {
  return [
    'function processName(value: unknown): string {',
    "  return String(value || '').split(/[\\\\/]/).pop()?.toLowerCase() || ''",
    '}',
    '',
    `const CONFIGURED_HOOK_PATH = '${configuredHookPath}'`,
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
    ...getPiOmpRuntimeDetectionSourceLines(`/hook/${kind}`),
    '',
    'function resolveHookPath(ompRuntime: boolean): string {',
    '  // Bare-shell OMP may run inside a configured Pi pane.',
    "  if (ompRuntime) return '/hook/omp'",
    '  return CONFIGURED_HOOK_PATH',
    '}'
  ]
}

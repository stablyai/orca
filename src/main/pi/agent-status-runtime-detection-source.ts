import type { PiAgentKind } from '../../shared/pi-agent-kind'

/** Why: a bare-shell OMP launch runs inside a pi-kind pane, so every extension that has to
 *  defer to OMP's own approval events needs this check — not just the status extension it
 *  was first written for. */
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
    '  ) || isGjcRuntime()',
    '  return cachedOmpRuntime',
    '}',
    '',
    '// Why: GJC is an OMP fork that auto-loads this extension from ~/.gjc/agent/extensions;',
    '// it keeps OMP semantics but reports on its own route so Orca can label it.',
    'let cachedGjcRuntime: boolean | null = null',
    '',
    'function isGjcRuntime(): boolean {',
    '  if (cachedGjcRuntime !== null) return cachedGjcRuntime',
    '  const names = [',
    '    processName(process.title),',
    '    processName(process.env._),',
    '    processName(process.argv[1]),',
    '    processName(process.argv[0])',
    '  ]',
    "  cachedGjcRuntime = names.some((name) => ['gjc', 'gjc.exe', 'gjc.cmd'].includes(name))",
    '  return cachedGjcRuntime',
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
    '  // Why: runtime detection keeps a bare-shell OMP launch from reporting as Pi.',
    "  if (ompRuntime) return isGjcRuntime() ? '/hook/gjc' : '/hook/omp'",
    '  return CONFIGURED_HOOK_PATH',
    '}'
  ]
}

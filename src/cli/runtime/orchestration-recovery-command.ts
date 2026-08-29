export function resolveOrchestrationCliExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string {
  const configured = env.ORCA_CLI_COMMAND?.trim()
  if (configured) {
    return configured
  }
  if (env.ORCA_DEV_REPO_ROOT) {
    return 'orca-dev'
  }
  return platform === 'linux' ? 'orca-ide' : 'orca'
}

export function buildOrchestrationRecoveryCommand(
  method: string,
  params: unknown,
  executable?: string,
  originalArgs?: readonly string[]
): string[] | undefined
export function buildOrchestrationRecoveryCommand(
  executable: string,
  method: string,
  params: unknown,
  originalArgs?: readonly string[]
): string[] | undefined
export function buildOrchestrationRecoveryCommand(
  methodOrExecutable: string,
  paramsOrMethod: unknown,
  executableOrParams?: unknown,
  originalArgs?: readonly string[]
): string[] | undefined {
  const legacyOrder = typeof paramsOrMethod === 'string' && executableOrParams !== undefined
  const method = (legacyOrder ? paramsOrMethod : methodOrExecutable) as string
  const params = legacyOrder ? executableOrParams : paramsOrMethod
  const executable = legacyOrder
    ? methodOrExecutable
    : typeof executableOrParams === 'string'
      ? executableOrParams
      : resolveOrchestrationCliExecutable()
  if (originalArgs && originalArgs.length > 0) {
    const recoverableArgs = recoverableOrchestrationArgs(originalArgs)
    return recoverableArgs ? [executable, ...recoverableArgs] : undefined
  }
  const command =
    method === 'orchestration.workerStart'
      ? 'worker-start'
      : method === 'orchestration.workerStop'
        ? 'worker-stop'
        : method === 'orchestration.workerAbandon'
          ? 'worker-abandon'
          : method === 'orchestration.workerRelease'
            ? 'worker-release'
            : method === 'orchestration.workerRetain'
              ? 'worker-retain'
              : undefined
  if (!command || params === null || typeof params !== 'object') {
    return undefined
  }
  const record = params as Record<string, unknown>
  const requiredKey = command === 'worker-start' ? 'task' : 'dispatch'
  if (typeof record[requiredKey] !== 'string' || record[requiredKey].length === 0) {
    return undefined
  }
  const args = [executable, 'orchestration', command]
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null || value === false) {
      continue
    }
    const flag = `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
    if (value === true) {
      args.push(flag)
    } else if (typeof value === 'string' || typeof value === 'number') {
      args.push(flag, String(value))
    }
  }
  return args
}

export function recoverableOrchestrationArgs(args: readonly string[]): string[] | undefined {
  const containsCredential = args.some((arg) =>
    ['--pairing-code', '--dispatch-capability'].some(
      (flag) => arg === flag || arg.startsWith(`${flag}=`)
    )
  )
  if (containsCredential) {
    return undefined
  }
  const result: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--retry-request') {
      index += 1
      continue
    }
    if (arg.startsWith('--retry-request=')) {
      continue
    }
    result.push(arg)
  }
  return result
}

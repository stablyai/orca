import { runProcess } from '@orca/process-host'
import { resolveMobileTypecheckCompiler } from './mobile-typecheck-compiler.mjs'

const compiler = resolveMobileTypecheckCompiler()
const abort = new AbortController()
// Keep the CLI alive while process-host's termination barrier settles.
const keepAlive = setInterval(() => undefined, 60_000)
let signalExitCode
const interrupt = () => {
  signalExitCode ??= 130
  abort.abort()
}
const terminate = () => {
  signalExitCode ??= 143
  abort.abort()
}
process.once('SIGINT', interrupt)
process.once('SIGTERM', terminate)
try {
  if (compiler.native) {
    console.log(`TypeScript ${compiler.version}: native compiler`)
  }
  const result = await runProcess({
    program: compiler.program,
    args: [...compiler.args, '--noEmit', ...process.argv.slice(2)],
    stdio: 'inherit',
    timeoutMs: null,
    signal: abort.signal,
    terminationBarrier: true
  })
  process.exitCode = signalExitCode ?? result.code ?? 1
} finally {
  clearInterval(keepAlive)
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', terminate)
}

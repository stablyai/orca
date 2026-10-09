export function createElectronViteDevArguments(args) {
  const separator = args.indexOf('--')
  const viteArgs = separator === -1 ? args : args.slice(0, separator)
  const controlsWatch = viteArgs.some(
    (arg) =>
      ['--watch', '-w', '--no-watch', '--help', '-h', '--version'].includes(arg) ||
      arg.startsWith('--watch=')
  )
  return ['dev', ...(controlsWatch ? [] : ['--watch']), ...args]
}

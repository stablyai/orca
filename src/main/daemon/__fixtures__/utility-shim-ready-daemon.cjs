// Fake daemon for the utility-launcher shim tests: reports ready over IPC,
// writes a stderr marker, then waits to be killed (self-exits as a backstop).
process.send({ type: 'ready', startedAtMs: 123 })
process.stderr.write('utility-shim-fixture-stderr')
setTimeout(() => process.exit(0), 15000)

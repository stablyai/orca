process.on('SIGTERM', () => {})
process.on('message', () => {})
process.on('disconnect', () => process.exit(0))
process.send?.({
  type: 'ready',
  protocolVersion: 1,
  workerId: '00000000-0000-4000-8000-000000000001'
})

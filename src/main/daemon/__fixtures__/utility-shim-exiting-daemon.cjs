// Fake daemon that dies during startup so the shim's exit relay is observable.
process.send({ type: 'starting' })
process.exit(7)

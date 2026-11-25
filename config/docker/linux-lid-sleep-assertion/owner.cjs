const { writeFileSync } = require('node:fs')
const { LinuxLidSleepAssertion } = require(process.argv[2])

const assertion = new LinuxLidSleepAssertion()
assertion.start('docker-lifetime-oracle')
writeFileSync(process.argv[3], String(process.pid))
process.stdin.on('data', () => assertion.stop('docker-release-oracle'))
setInterval(() => {}, 1000)

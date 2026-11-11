import { writeFileSync } from 'node:fs'

process.on('SIGINT', () => {
  if (process.argv[2]) {
    setTimeout(() => {
      writeFileSync(process.argv[2], 'cleaned')
      process.exit(0)
    }, 1000)
  }
})
console.log('ready')
setInterval(() => {}, 1000)

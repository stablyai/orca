// One-time macOS dev-time generation: no sharp/resvg/jimp is installed in this
// repo, so this shells out to macOS's built-in `sips` to downscale the app icon.
// The committed icon-*.png files are the shipped assets — this script does not
// run at build or install time.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const dir = import.meta.dirname
const src = join(dir, '../../../resources/build/icon.png')

for (const n of [16, 32, 48, 128]) {
  execFileSync('sips', ['-z', String(n), String(n), src, '--out', join(dir, `icon-${n}.png`)], {
    stdio: 'ignore'
  })
}

console.log('generated icon-{16,32,48,128}.png')

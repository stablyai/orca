// One-time macOS dev-time generation: no sharp/resvg/jimp is installed in this
// repo, so this shells out to macOS's built-in `sips` to downscale the app icon.
// The committed icon-*.png files are the shipped assets — this script does not
// run at build or install time.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// sips는 macOS 전용이라 다른 플랫폼에서 돌리면 execFileSync가 알아보기 힘든 에러를 던진다.
// 커밋된 icon-*.png를 쓰라고 명확히 안내하고 종료한다.
if (process.platform !== 'darwin') {
  console.error('아이콘 생성 스크립트는 macOS의 sips가 필요합니다. 커밋된 PNG를 사용하세요.')
  process.exit(1)
}

const dir = import.meta.dirname
const src = join(dir, '../../../resources/build/icon.png')

for (const n of [16, 32, 48, 128]) {
  execFileSync('sips', ['-z', String(n), String(n), src, '--out', join(dir, `icon-${n}.png`)], {
    stdio: 'ignore'
  })
}

console.log('generated icon-{16,32,48,128}.png')

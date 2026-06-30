import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const indexPath = resolve('out/web/web-index.html')
const html = await readFile(indexPath, 'utf8')

const absoluteAssetReference = /\b(?:src|href)=["']\/assets\//.exec(html)

if (absoluteAssetReference) {
  console.error(
    `Web build must use relative asset URLs for reverse-proxy pairing URLs; found ${absoluteAssetReference[0]} in ${indexPath}`
  )
  process.exit(1)
}

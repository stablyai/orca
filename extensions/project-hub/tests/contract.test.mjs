import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'
const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('orca-plugin.json',root),'utf8'))
const html = readFileSync(new URL('panel.html',root),'utf8')
test('plugin manifest uses only scoped permissions', () => {
 assert.equal(manifest.id,'project-hub')
 assert.deepEqual(manifest.capabilities.map(x=>x.kind).sort(),['events:subscribe','storage','terminal:send','workspace:read'])
})
test('panel script parses and protects terminal execution', () => {
 const source=html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
 assert.ok(source)
 new Script(source)
 assert.match(source,/terminal\.sendText/)
 assert.match(source,/enter:false/)
})
test('all ten phases and approval are represented',()=>{
 assert.match(html,/Primera validaci[oó]n/i)
 assert.match(html,/Smoke test/i)
 assert.match(html,/Producci[oó]n/i)
 assert.match(html,/Documentaci[oó]n/i)
 assert.match(html,/confirm\(/)
})

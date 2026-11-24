const fs = require('node:fs')
const path = require('node:path')

module.exports = function writeLiveActivityAgentIcons(mobileRoot, output) {
  const source = path.join(mobileRoot, '../src/shared/agent-icons')
  const catalog = path.join(output, 'AgentIcons.xcassets')
  fs.mkdirSync(catalog, { recursive: true })
  const write = (directory, value) =>
    fs.writeFileSync(path.join(directory, 'Contents.json'), JSON.stringify(value))
  write(catalog, { info: { author: 'xcode', version: 1 } })
  const marks = JSON.parse(fs.readFileSync(path.join(source, 'provider-marks.json'), 'utf8'))
  for (const [agent, mark] of Object.entries(marks)) {
    const directory = path.join(catalog, `live-agent-${agent}.imageset`)
    fs.mkdirSync(directory, { recursive: true })
    const gradient = mark.gradient
      ? `<defs><linearGradient id="mark" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${mark.gradient[0]}"/><stop offset=".5" stop-color="${mark.gradient[1]}"/><stop offset="1" stop-color="${mark.gradient[2]}"/></linearGradient></defs>`
      : ''
    const paths = [mark.path, mark.secondaryPath]
      .filter(Boolean)
      .map((d) => `<path d="${d}" fill-rule="${mark.fillRule}"/>`)
      .join('')
    fs.writeFileSync(
      path.join(directory, 'icon.svg'),
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${mark.viewBox ?? '0 0 24 24'}">${gradient}<g transform="${mark.transform ?? ''}" fill="${mark.gradient ? 'url(#mark)' : mark.color}">${paths}</g></svg>`
    )
    write(directory, {
      info: { author: 'xcode', version: 1 },
      images: [{ idiom: 'universal', filename: 'icon.svg' }],
      properties: {
        'preserves-vector-representation': true,
        'template-rendering-intent': agent === 'claude' || mark.gradient ? 'original' : 'template'
      }
    })
  }
  for (const filename of fs.readdirSync(source).filter((name) => name.endsWith('.png'))) {
    const directory = path.join(catalog, `live-agent-${path.basename(filename, '.png')}.imageset`)
    fs.mkdirSync(directory, { recursive: true })
    fs.copyFileSync(path.join(source, filename), path.join(directory, filename))
    write(directory, {
      info: { author: 'xcode', version: 1 },
      images: [{ idiom: 'universal', filename }]
    })
  }
}

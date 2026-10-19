import { describe, expect, it } from 'vitest'
import { summarizeSamplingProfile, trustedScriptPrefixFor } from './renderer-heap-allocation-sites'

const PAGE = 'file:///Users/someone/Orca.app/Contents/Resources/app.asar/out/renderer/index.html'
const BUNDLE = trustedScriptPrefixFor(PAGE)

function frame(functionName: string, url: string, scriptId = '7', lineNumber = 9) {
  return { functionName, url, scriptId, lineNumber, columnNumber: 4 }
}

type ProfileNode = {
  callFrame: ReturnType<typeof frame>
  selfSize: number
  children?: ProfileNode[]
}

function leaf(callFrame: ReturnType<typeof frame>, kb: number): ProfileNode {
  return { callFrame, selfSize: kb * 1024 }
}

function sitesOf(...children: ProfileNode[]): string[] {
  const summary = summarizeSamplingProfile(
    { head: { callFrame: frame('(root)', '', '0'), selfSize: 0, children } },
    BUNDLE
  )
  return Object.keys(summary)
    .filter((key) => /^site\d+$/.test(key))
    .sort()
    .map((key) => String(summary[key]))
}

describe('summarizeSamplingProfile', () => {
  it('names frames from the window bundle by function, file name and line', () => {
    const summary = summarizeSamplingProfile(
      {
        head: {
          callFrame: frame('(root)', '', '0'),
          selfSize: 0,
          children: [
            {
              callFrame: frame('appendChunk', `${BUNDLE}terminal-Ab12.js`),
              selfSize: 0,
              children: [leaf(frame('sliceOutput', `${BUNDLE}terminal-Ab12.js`, '7', 20), 3072)]
            },
            leaf(frame('join', '', '0'), 1024)
          ]
        }
      },
      BUNDLE
    )

    expect(summary).toEqual({
      sampledLiveMB: 4,
      siteCount: 2,
      site01: '3072KB sliceOutput@terminal-Ab12.js:21:5 < appendChunk@terminal-Ab12.js:10:5',
      site02: '1024KB join'
    })
    expect(JSON.stringify(summary)).not.toContain('someone')
  })

  it('reduces every frame outside the bundle to a fixed label, name included', () => {
    expect(
      sitesOf(
        leaf(frame('customerAlice', 'file:///private/PersonalTaxReturn.js'), 5),
        leaf(frame('secretName', 'data:text/javascript,secret.js'), 4),
        leaf(frame('ProjectFalcon', '', '12'), 3),
        leaf(frame('allocate', `${BUNDLE}nested/CustomerPlan.js`), 2)
      )
    ).toEqual(['14KB (other script)'])
  })

  it('replaces names that are not plain code identifiers instead of stripping them', () => {
    expect(
      sitesOf(
        leaf(frame('sk-abcdefghijklmnopqrstuvwx', `${BUNDLE}index-Zx9.js`), 3),
        leaf(frame('my file.txt', '', '0'), 2),
        leaf(frame('(V8 API)', '', '0'), 1)
      )
    ).toEqual(['3KB (anonymous)@index-Zx9.js:10:5', '2KB (native)', '1KB (V8 API)'])
  })

  it('names nothing from scripts when the bundle location is unknown', () => {
    const summary = summarizeSamplingProfile(
      {
        head: {
          callFrame: frame('(root)', '', '0'),
          selfSize: 0,
          children: [leaf(frame('appendChunk', `${BUNDLE}terminal-Ab12.js`), 1)]
        }
      },
      null
    )
    expect(summary.site01).toBe('1KB (other script)')
  })
})

describe('site length', () => {
  it('drops whole caller frames to stay inside the crumb string budget', () => {
    const long = 'a'.repeat(48)
    let node = leaf(frame(long, `${BUNDLE}${'b'.repeat(60)}.js`), 1)
    for (let depth = 0; depth < 3; depth++) {
      node = { ...leaf(frame(long, `${BUNDLE}${'b'.repeat(60)}.js`), 0), children: [node] }
    }
    const [site] = sitesOf(node)

    expect(site.length).toBeLessThanOrEqual(240)
    expect(site.endsWith('.js:10:5')).toBe(true)
  })
})

describe('trustedScriptPrefixFor', () => {
  it('is the assets folder next to the page', () => {
    expect(trustedScriptPrefixFor(`${PAGE}?x=1#hash`)).toBe(
      'file:///Users/someone/Orca.app/Contents/Resources/app.asar/out/renderer/assets/'
    )
    expect(trustedScriptPrefixFor('http://localhost:5173/')).toBe('http://localhost:5173/assets/')
    expect(trustedScriptPrefixFor('about:blank')).toBeNull()
    expect(trustedScriptPrefixFor('')).toBeNull()
  })
})

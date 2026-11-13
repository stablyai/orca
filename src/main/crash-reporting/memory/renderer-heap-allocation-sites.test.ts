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
})

import { describe, expect, it } from 'vitest'
import { compareRuns, formatTable, METRICS } from './fleet-gate-report.mjs'
import { locateStoreNotifications } from './fleet-gate-store-notify.mjs'

// Zustand factory from an Oxc-minified renderer chunk. The callback shadows the listener set name.
const rendererChunk =
  'var r=e=>{let t,n=new Set,r=(e,r)=>{let i=typeof e==`function`?e(t):e;if(!Object.is(i,t)){let e=t;t=r??(typeof i!=`object`||!i)?i:Object.assign({},t,i),n.forEach(n=>n(t,e))}},i=()=>t,a={setState:r,getState:i,getInitialState:()=>o,subscribe:e=>(n.add(e),()=>n.delete(e))},o=t=e(r,i,a);return a};'

describe('fleet gate store probe', () => {
  it('locates the publication call in a short minified renderer chunk', () => {
    const call = 'n.forEach(n=>n(t,e))'
    const start = rendererChunk.indexOf(call)
    expect(locateStoreNotifications(rendererChunk)).toEqual([
      { start, end: start + call.length, listeners: 'n', next: 't', previous: 'e' }
    ])
  })

  it('follows the store setter when the merge and callback are emitted differently', () => {
    const source = `
      const unrelated = (listeners, state, prev) => listeners.forEach(fn => fn(state, prev));
      function createStore() {
        const subscribers = new Set();
        let current;
        const setState = (patch) => {
          const old = current;
          current = { ...current, ...patch };
          subscribers.forEach( function (subscriber) { subscriber(current, old); } );
        };
        return { setState, getState: () => current, subscribe: (fn) => subscribers.add(fn) };
      }
    `
    const call = 'subscribers.forEach( function (subscriber) { subscriber(current, old); } )'
    const start = source.indexOf(call)
    expect(locateStoreNotifications(source)).toEqual([
      {
        start,
        end: start + call.length,
        listeners: 'subscribers',
        next: 'current',
        previous: 'old'
      }
    ])
  })

  it.each([0, 1])(
    'skips unavailable store metrics with %i installed breakpoints',
    (breakpoints) => {
      const metrics = Object.fromEntries(
        METRICS.map(({ key, store }) => [key, store ? Number.NaN : 1])
      )
      const runs = [
        {
          arm: 'old',
          storeBreakpoints: breakpoints,
          storeMeasured: false,
          windows: { streaming: { metrics } }
        },
        {
          arm: 'new',
          storeBreakpoints: 1,
          storeMeasured: true,
          windows: {
            streaming: {
              metrics: { ...metrics, pubsPerSec: 20, noopPubsPerSec: 0, wakeupsPerSec: 400 }
            }
          }
        }
      ]
      const report = () => formatTable({ rows: compareRuns(runs, ['streaming']), notes: [] })
      expect(report().result).toBe('PASS')
      expect(report().text).toContain('not measured')

      metrics.rendererHeapMb = Number.NaN
      expect(report().result).toBe('INCOMPLETE')
    }
  )
})

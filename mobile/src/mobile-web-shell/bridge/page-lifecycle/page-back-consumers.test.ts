import { describe, expect, it } from 'vitest'
import { createPageBackConsumers } from './page-back-consumers'

describe('createPageBackConsumers', () => {
  it('asks the newest consumer first and still reaches the one it removes', () => {
    const seen: string[] = []
    const backs = createPageBackConsumers({
      publishClaim: () => {},
      onUnclaimed: () => {}
    })
    const dropOlder = backs.claim(() => {
      seen.push('older')
      return true
    })
    backs.claim(() => {
      seen.push('newer')
      dropOlder()
      return false
    })
    backs.press()
    expect(seen).toEqual(['newer', 'older'])
  })
})

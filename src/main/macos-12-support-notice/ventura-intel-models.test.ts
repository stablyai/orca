import { describe, expect, it } from 'vitest'
import { getIntelMacos13Support } from './ventura-intel-models'

describe('Ventura hardware compatibility', () => {
  it.each([
    ['MacBook9,1', 'unsupported'],
    ['MacBook10,1', 'supported'],
    ['MacBookAir7,2', 'unsupported'],
    ['MacBookAir8,1', 'supported'],
    ['MacBookPro13,3', 'unsupported'],
    ['MacBookPro14,1', 'supported'],
    ['MacBookPro16,4', 'supported'],
    ['Macmini7,1', 'unsupported'],
    ['Macmini8,1', 'supported'],
    ['iMac17,1', 'unsupported'],
    ['iMac18,1', 'supported'],
    ['iMac20,2', 'supported'],
    ['iMacPro1,1', 'supported'],
    ['MacPro6,1', 'unsupported'],
    ['MacPro7,1', 'supported'],
    ['VirtualMac2,1', 'unknown'],
    ['MacBookPro99,1', 'unknown'],
    ['', 'unknown']
  ])('uses Apple’s Ventura model boundary for %s', (model, expected) => {
    expect(getIntelMacos13Support(model)).toBe(expected)
  })
})

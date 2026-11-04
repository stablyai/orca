import { describe, expect, it } from 'vitest'
import {
  parseLinuxDmi,
  parseMacHardwareProfile,
  parseWindowsComputerSystem,
  type LinuxDmiFields
} from './host-machine-probe-parsing'

function macProfile(fields: Record<string, string>): string {
  return JSON.stringify({ SPHardwareDataType: [{ _name: 'hardware_overview', ...fields }] })
}

describe('parseMacHardwareProfile', () => {
  it('reads the marketing name and treats MacBooks as laptops', () => {
    expect(
      parseMacHardwareProfile(
        macProfile({ machine_name: 'MacBook Pro', machine_model: 'Mac16,5', serial_number: 'X' })
      )
    ).toEqual({ kind: 'laptop', model: 'MacBook Pro' })
    expect(
      parseMacHardwareProfile(macProfile({ machine_name: 'Mac mini', machine_model: 'Mac16,10' }))
    ).toEqual({ kind: 'desktop', model: 'Mac mini' })
  })

  it('falls back to the Intel model identifier for the kind when the name is missing', () => {
    expect(parseMacHardwareProfile(macProfile({ machine_model: 'MacBookAir9,1' }))).toEqual({
      kind: 'laptop',
      model: null
    })
  })

  it('rejects unreadable output', () => {
    expect(parseMacHardwareProfile('not json')).toBeNull()
    expect(parseMacHardwareProfile('{"SPHardwareDataType":[]}')).toBeNull()
  })
})

describe('parseWindowsComputerSystem', () => {
  const row = (fields: Record<string, unknown>): string => JSON.stringify(fields)

  it('reads mobile PCs as laptops and prefers the family over a Lenovo type code', () => {
    expect(
      parseWindowsComputerSystem(
        row({
          PCSystemType: 2,
          Model: '20XWCTO1WW',
          Manufacturer: 'LENOVO',
          SystemFamily: 'ThinkPad X1 Carbon Gen 9',
          ProductType: 1
        })
      )
    ).toEqual({ kind: 'laptop', model: 'ThinkPad X1 Carbon Gen 9' })
  })

  it('drops firmware placeholders', () => {
    expect(
      parseWindowsComputerSystem(
        row({
          PCSystemType: 1,
          Model: 'System Product Name',
          Manufacturer: 'System manufacturer',
          SystemFamily: 'To Be Filled By O.E.M.',
          ProductType: 1
        })
      )
    ).toEqual({ kind: 'desktop', model: null })
  })

  it('reads Windows Server and virtual machines as servers', () => {
    expect(
      parseWindowsComputerSystem(
        row({ PCSystemType: 1, Model: 'PowerEdge R740', Manufacturer: 'Dell Inc.', ProductType: 3 })
      )
    ).toEqual({ kind: 'server', model: 'PowerEdge R740' })
    expect(
      parseWindowsComputerSystem(
        row({ PCSystemType: 1, Model: 'Virtual Machine', Manufacturer: 'Microsoft Corporation' })
      )
    ).toEqual({ kind: 'server', model: null })
  })

  it('rejects unreadable output', () => {
    expect(parseWindowsComputerSystem('')).toBeNull()
    expect(parseWindowsComputerSystem('[1]')).toBeNull()
  })
})

describe('parseLinuxDmi', () => {
  const dmi = (fields: Partial<LinuxDmiFields>): LinuxDmiFields => ({
    chassisType: null,
    productName: null,
    productFamily: null,
    sysVendor: null,
    ...fields
  })

  it('maps chassis types to laptop, desktop and server', () => {
    expect(parseLinuxDmi(dmi({ chassisType: '10', productName: 'XPS 13 9310' }))).toEqual({
      kind: 'laptop',
      model: 'XPS 13 9310'
    })
    expect(parseLinuxDmi(dmi({ chassisType: '3', productName: 'Default string' }))).toEqual({
      kind: 'desktop',
      model: null
    })
    expect(parseLinuxDmi(dmi({ chassisType: '23', productName: 'ProLiant DL380 Gen10' }))).toEqual({
      kind: 'server',
      model: 'ProLiant DL380 Gen10'
    })
  })

  it('reads missing DMI and virtual machines as servers without a model', () => {
    expect(parseLinuxDmi(dmi({}))).toEqual({ kind: 'server', model: null })
    expect(
      parseLinuxDmi(
        dmi({ chassisType: '1', productName: 'Standard PC (Q35 + ICH9, 2009)', sysVendor: 'QEMU' })
      )
    ).toEqual({ kind: 'server', model: null })
    expect(
      parseLinuxDmi(
        dmi({
          chassisType: '3',
          productName: 'Virtual Machine',
          sysVendor: 'Microsoft Corporation'
        })
      )
    ).toEqual({ kind: 'server', model: null })
  })
})

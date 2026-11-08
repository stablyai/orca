import { expect, it } from 'vitest'
import { parseEmulatorRegistration } from './emulator-grpc-discovery'

it('uses the registered endpoint and credential for the selected emulator', () => {
  expect(
    parseEmulatorRegistration(
      'port.serial=5610\ngrpc.port=48291\ngrpc.token=local-test-token\n',
      'emulator-5610'
    )
  ).toEqual({ address: '127.0.0.1:48291', token: 'local-test-token' })
})

it('refuses unauthenticated discovery and registrations for another emulator', () => {
  expect(
    parseEmulatorRegistration('port.serial=5610\ngrpc.port=48291\n', 'emulator-5610')
  ).toBeNull()
  expect(
    parseEmulatorRegistration(
      'port.serial=5612\ngrpc.port=48291\ngrpc.token=test\n',
      'emulator-5610'
    )
  ).toBeNull()
})

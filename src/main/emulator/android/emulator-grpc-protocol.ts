import { Client, Metadata, credentials, status } from '@grpc/grpc-js'
import type { ClientWritableStream } from '@grpc/grpc-js'
import { parse } from 'protobufjs'
import type { EmulatorGrpcEndpoint } from './emulator-grpc-discovery'

// Wire field numbers from the SDK's Apache-2.0 emulator_controller.proto.
const root = parse(`syntax = "proto3";
message Empty {}
message ParameterValue { repeated float data = 1 [packed = true]; }
message PhysicalModelValue { int32 target = 1; ParameterValue value = 3; }
message Rotation { int32 rotation = 1; }
message FoldedDisplay { uint32 width = 1; uint32 height = 2; uint32 xOffset = 3; uint32 yOffset = 4; }
message ImageFormat { int32 format = 1; Rotation rotation = 2; uint32 width = 3; uint32 height = 4; uint32 display = 5; FoldedDisplay foldedDisplay = 7; }
message Image { ImageFormat format = 1; bytes image = 4; uint32 seq = 5; uint64 timestampUs = 6; }
message DisplayConfiguration { uint32 width = 1; uint32 height = 2; uint32 display = 5; }
message DisplayConfigurations { repeated DisplayConfiguration displays = 1; }
message Touch { int32 x = 1; int32 y = 2; int32 identifier = 3; int32 pressure = 4; }
message TouchEvent { repeated Touch touches = 1; int32 display = 2; }
message MouseEvent { int32 x = 1; int32 y = 2; int32 buttons = 3; int32 display = 4; }
message WheelEvent { int32 dx = 1; int32 dy = 2; int32 display = 3; }
message InputEvent { TouchEvent touchEvent = 2; MouseEvent mouseEvent = 3; WheelEvent wheelEvent = 6; }
`).root

export type GrpcImage = {
  format: {
    width: number
    height: number
    rotation?: { rotation: number }
    foldedDisplay?: { width: number }
  }
  image: Buffer
  seq: number
  timestampUs: { toString(): string }
}
export type GrpcInput = {
  touchEvent?: { touches: { x: number; y: number; identifier: number; pressure: number }[] }
  mouseEvent?: { x: number; y: number; buttons: number }
  wheelEvent?: { dx: number; dy: number }
}
type EmulatorGrpcRequest =
  | GrpcInput
  | { format: number; width: number; height: number }
  | { target: number; value: { data: number[] } }

function codec<T extends object = object>(
  name: string
): {
  encode: (value: EmulatorGrpcRequest) => Buffer
  decode: (bytes: Buffer) => T
} {
  const type = root.lookupType(name)
  return {
    encode: (value) => Buffer.from(type.encode(type.create(value)).finish()),
    decode: (bytes) => {
      const value: object = type.decode(bytes)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Each codec type matches the emulator wire schema declared above.
      return value as T
    }
  }
}
const empty = codec('Empty'),
  image = codec<GrpcImage>('Image'),
  format = codec('ImageFormat'),
  input = codec('InputEvent')
const displays = codec<{ displays?: { display?: number; width: number; height: number }[] }>(
  'DisplayConfigurations'
)
const physicalModel = codec('PhysicalModelValue')
const service = '/android.emulation.control.EmulatorController/'

export class EmulatorGrpcClient {
  readonly client: Client
  readonly metadata = new Metadata()
  constructor(endpoint: EmulatorGrpcEndpoint) {
    this.client = new Client(endpoint.address, credentials.createInsecure(), {
      'grpc.max_receive_message_length': 64 * 1024 * 1024,
      'grpc-node.flow_control_window': 8 * 1024 * 1024,
      'grpc.initial_reconnect_backoff_ms': 250
    })
    this.metadata.set('authorization', `Bearer ${endpoint.token}`)
  }
  /** Uses display zero in natural orientation; missing dimensions reject native startup. */
  displaySize(): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      this.client.makeUnaryRequest(
        `${service}getDisplayConfigurations`,
        empty.encode,
        displays.decode,
        {},
        this.metadata,
        { deadline: Date.now() + 3000 },
        (error, response) => {
          const display = response?.displays?.find((item) => !item.display)
          if (error || !display?.width || !display.height) {
            reject(error ?? new Error('Missing emulator display'))
          } else {
            resolve(display)
          }
        }
      )
    })
  }
  /** Requests RGB888 frames bounded by the viewport, including empty frames while asleep. */
  screenshots(width: number, height: number) {
    return this.client.makeServerStreamRequest(
      `${service}streamScreenshot`,
      format.encode,
      image.decode,
      { format: 2, width, height },
      this.metadata
    )
  }
  /** Quadrants map to emulator physical-model angles, not a renderer-only transform. */
  rotate(quadrants: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const angle = [0, 90, -180, -90][quadrants] ?? 0
      this.client.makeUnaryRequest(
        `${service}setPhysicalModel`,
        physicalModel.encode,
        empty.decode,
        { target: 1, value: { data: [0, 0, angle] } },
        this.metadata,
        { deadline: Date.now() + 3000 },
        (error) => (error ? reject(error) : resolve())
      )
    })
  }
  input() {
    return this.client.makeClientStreamRequest<GrpcInput, object>(
      `${service}streamInputEvent`,
      input.encode,
      empty.decode,
      this.metadata,
      () => {}
    )
  }
  /** Allow queued release input to finish before closing the channel, with a bounded wait. */
  close(input: ClientWritableStream<GrpcInput> | null): Promise<void> {
    if (!input) {
      this.client.close()
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      const done = () => {
        this.client.close()
        resolve()
      }
      const timer = setTimeout(done, 1000)
      timer.unref()
      input.once('status', () => {
        clearTimeout(timer)
        done()
      })
      input.end()
    })
  }
}

/** These status codes require a transport fallback rather than retrying the same RPC. */
export function isUnsupportedEmulatorGrpc(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === status.UNIMPLEMENTED || error.code === status.INVALID_ARGUMENT)
  )
}

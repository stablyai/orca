// Why: the browser method surface area is large enough that keeping every
// schema in the same file as its handler registration pushes the file past
// the 300-line lint cap. Grouping all browser schemas here keeps each
// handler file focused on dispatch wiring.
import { z } from 'zod'
import {
  BrowserTarget,
  OptionalBoolean,
  OptionalFiniteNumber,
  OptionalPlainString,
  OptionalString,
  requiredString
} from '../schemas'

export const Element = BrowserTarget.extend({
  element: requiredString('Missing required --element')
})

export const Goto = BrowserTarget.extend({
  url: requiredString('Missing required --url')
})

export const Fill = BrowserTarget.extend({
  element: requiredString('Missing required --element'),
  value: z.custom<string>((v) => typeof v === 'string', {
    message: 'Missing required --value'
  })
})

export const Type = BrowserTarget.extend({
  input: requiredString('Missing required --input')
})

export const Select = BrowserTarget.extend({
  element: requiredString('Missing required --element'),
  value: z.custom<string>((v) => typeof v === 'string', {
    message: 'Missing required --value'
  })
})

export const Scroll = BrowserTarget.extend({
  direction: z.custom<'up' | 'down'>((v) => v === 'up' || v === 'down', {
    message: 'Missing required --direction (up or down)'
  }),
  amount: z
    .unknown()
    .transform((v) => (typeof v === 'number' && v > 0 ? v : undefined))
    .pipe(z.number().optional())
})

export const Screenshot = BrowserTarget.extend({
  format: z
    .unknown()
    .transform((v) => (v === 'png' || v === 'jpeg' ? v : undefined))
    .pipe(z.enum(['png', 'jpeg']).optional())
})

export const FullScreenshot = BrowserTarget.extend({
  format: z
    .unknown()
    .transform((v) => (v === 'jpeg' ? 'jpeg' : 'png'))
    .pipe(z.enum(['png', 'jpeg']))
})

export const Eval = BrowserTarget.extend({
  expression: requiredString('Missing required --expression')
})

export const TabList = z.object({
  worktree: OptionalString
})

// Why: --index xor --page must be present. The refine guards that invariant
// so the dispatcher surfaces a single legible error instead of either shape
// leaking into the runtime.
export const TabSwitch = BrowserTarget.extend({
  index: z
    .unknown()
    .transform((v) => (typeof v === 'number' ? v : undefined))
    .pipe(z.number().optional())
}).refine(
  (val) => {
    if (val.page !== undefined) {
      return true
    }
    return val.index !== undefined && Number.isInteger(val.index) && val.index >= 0
  },
  { message: 'Missing required --index (non-negative integer) or --page' }
)

export const TabCreate = z.object({
  url: OptionalString,
  worktree: OptionalString
})

export const TabClose = z.object({
  index: z
    .unknown()
    .transform((v) => (typeof v === 'number' ? v : undefined))
    .pipe(z.number().optional()),
  page: OptionalString,
  worktree: OptionalString
})

export const Drag = BrowserTarget.extend({
  from: requiredString('Missing required --from and --to element refs'),
  to: requiredString('Missing required --from and --to element refs')
})

export const Upload = BrowserTarget.extend({
  element: requiredString('Missing required --element and --files'),
  files: z.custom<string[]>(
    (v) => Array.isArray(v) && v.length > 0 && v.every((f) => typeof f === 'string'),
    { message: 'Missing required --element and --files' }
  )
})

export const Wait = BrowserTarget.extend({
  selector: OptionalPlainString,
  timeout: z
    .unknown()
    .transform((v) => (typeof v === 'number' && v > 0 ? v : undefined))
    .pipe(z.number().optional()),
  text: OptionalPlainString,
  url: OptionalPlainString,
  load: OptionalPlainString,
  fn: OptionalPlainString,
  state: OptionalPlainString
})

export const Check = BrowserTarget.extend({
  element: requiredString('Missing required --element'),
  checked: z
    .unknown()
    .transform((v) => v !== false)
    .pipe(z.boolean())
})

export const Keypress = BrowserTarget.extend({
  key: requiredString('Missing required --key')
})

export const SelectorPath = BrowserTarget.extend({
  selector: requiredString('Missing required --selector and --path'),
  path: requiredString('Missing required --selector and --path')
})

export const Highlight = BrowserTarget.extend({
  selector: requiredString('Missing required --selector')
})

export const Exec = BrowserTarget.extend({
  command: requiredString('Missing required --command')
})

export const Get = BrowserTarget.extend({
  what: requiredString('Missing required --what'),
  selector: OptionalString
})

export const Is = BrowserTarget.extend({
  what: z.custom<string>((v) => typeof v === 'string' && v.length > 0, {
    message: 'Missing required --what and --element'
  }),
  selector: z.custom<string>((v) => typeof v === 'string' && v.length > 0, {
    message: 'Missing required --what and --element'
  })
})

export const KeyboardInsert = BrowserTarget.extend({
  text: requiredString('Missing required --text')
})

export const LimitParam = BrowserTarget.extend({
  limit: OptionalFiniteNumber
})

export const Find = BrowserTarget.extend({
  locator: requiredString('Missing required --locator, --value, and --action'),
  value: requiredString('Missing required --locator, --value, and --action'),
  action: requiredString('Missing required --locator, --value, and --action'),
  text: OptionalString
})

export const CookieGet = BrowserTarget.extend({
  url: OptionalPlainString
})

export const CookieSet = BrowserTarget.extend({
  name: z.custom<string>((v) => typeof v === 'string' && v.length > 0, {
    message: 'Missing name or value'
  }),
  value: z.custom<string>((v) => typeof v === 'string', {
    message: 'Missing name or value'
  }),
  domain: OptionalPlainString,
  path: OptionalPlainString,
  secure: OptionalBoolean,
  httpOnly: OptionalBoolean,
  sameSite: OptionalPlainString,
  expires: OptionalFiniteNumber
})

export const CookieDelete = BrowserTarget.extend({
  name: requiredString('Missing cookie name'),
  domain: OptionalPlainString,
  url: OptionalPlainString
})

export const Viewport = BrowserTarget.extend({
  width: z.custom<number>((v) => typeof v === 'number' && v > 0, {
    message: 'Width and height must be positive numbers'
  }),
  height: z.custom<number>((v) => typeof v === 'number' && v > 0, {
    message: 'Width and height must be positive numbers'
  }),
  deviceScaleFactor: OptionalFiniteNumber,
  mobile: OptionalBoolean
})

export const Geolocation = BrowserTarget.extend({
  latitude: z.custom<number>((v) => typeof v === 'number', {
    message: 'Missing latitude or longitude'
  }),
  longitude: z.custom<number>((v) => typeof v === 'number', {
    message: 'Missing latitude or longitude'
  }),
  accuracy: OptionalFiniteNumber
})

export const InterceptEnable = BrowserTarget.extend({
  patterns: z
    .unknown()
    .transform((v) => (Array.isArray(v) ? (v as string[]) : undefined))
    .pipe(z.array(z.string()).optional())
})

export const MouseXY = BrowserTarget.extend({
  x: z.custom<number>((v) => typeof v === 'number', {
    message: 'Missing required x and y coordinates'
  }),
  y: z.custom<number>((v) => typeof v === 'number', {
    message: 'Missing required x and y coordinates'
  })
})

export const MouseButton = BrowserTarget.extend({
  button: OptionalPlainString
})

export const MouseWheel = BrowserTarget.extend({
  dy: z.custom<number>((v) => typeof v === 'number', {
    message: 'Missing required --dy'
  }),
  dx: OptionalFiniteNumber
})

export const SetDevice = BrowserTarget.extend({
  name: requiredString('Missing required --name')
})

export const SetOffline = BrowserTarget.extend({
  state: OptionalPlainString
})

export const SetHeaders = BrowserTarget.extend({
  headers: requiredString('Missing required --headers (JSON string)')
})

export const SetCredentials = BrowserTarget.extend({
  user: z.custom<string>((v) => typeof v === 'string' && v.length > 0, {
    message: 'Missing required --user and --pass'
  }),
  pass: z.custom<string>((v) => typeof v === 'string', {
    message: 'Missing required --user and --pass'
  })
})

export const SetMedia = BrowserTarget.extend({
  colorScheme: OptionalPlainString,
  reducedMotion: OptionalPlainString
})

export const ClipboardWrite = BrowserTarget.extend({
  text: requiredString('Missing required --text')
})

export const DialogAccept = BrowserTarget.extend({
  text: OptionalPlainString
})

export const StorageKey = BrowserTarget.extend({
  key: requiredString('Missing required --key')
})

export const StorageKeyValue = BrowserTarget.extend({
  key: z.custom<string>((v) => typeof v === 'string' && v.length > 0, {
    message: 'Missing required --key and --value'
  }),
  value: z.custom<string>((v) => typeof v === 'string', {
    message: 'Missing required --key and --value'
  })
})

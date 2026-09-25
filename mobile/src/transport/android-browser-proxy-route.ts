import type { BrowserLoopbackNative } from '../../modules/orca-mobile-web-shell/src/browser-loopback'
import {
  MobileBrowserTunnelConnection,
  type MobileBrowserTunnelConnectionOptions
} from './mobile-browser-tunnel-connection'
import {
  AndroidBrowserTunnelSocket,
  type AndroidBrowserByteStream
} from './android-browser-tunnel-socket'
import { ANDROID_SOCKS_REPLY, readAndroidSocksTarget } from './android-browser-socks-handshake'

type RouteOptions = Omit<
  MobileBrowserTunnelConnectionOptions<AndroidBrowserTunnelSocket>,
  'createSocket' | 'onClosed'
>

/** Explicit lease/execution-route owner, shared by all consumers; no production caller yet. */
export class AndroidBrowserProxyRoute {
  readonly ready: Promise<{ host: '127.0.0.1'; port: number } | null>
  private connection: MobileBrowserTunnelConnection<AndroidBrowserTunnelSocket> | null = null
  private route: number | null = null
  private closed = false
  private readonly peers = new Map<number, AndroidBrowserTunnelSocket | null>()
  private capacity = () => {}
  private readonly abort = () => this.close()

  constructor(
    private readonly native: BrowserLoopbackNative,
    private readonly options: RouteOptions
  ) {
    options.signal?.addEventListener('abort', this.abort, { once: true })
    try {
      this.connection = new MobileBrowserTunnelConnection({
        ...options,
        createSocket: (callbacks) => new AndroidBrowserTunnelSocket(callbacks),
        onClosed: () => this.close()
      })
    } catch (error) {
      this.close()
      throw error
    }
    if (this.closed) {
      this.connection.close()
    }
    this.ready = this.start()
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.options.signal?.removeEventListener('abort', this.abort)
    this.capacity()
    for (const socket of this.peers.values()) {
      socket?.destroy()
    }
    this.peers.clear()
    if (this.route !== null) {
      const route = this.route
      this.route = null
      this.closeNative(() => this.native.browserProxyClose(route))
    }
    this.connection?.close()
  }

  private closeNative(close: () => void): void {
    try {
      close()
    } catch {
      // Obsolete native handles must not interrupt local disposal.
    }
  }

  private async start(): Promise<{ host: '127.0.0.1'; port: number } | null> {
    try {
      const tunnel = await this.connection!.ready
      if (!tunnel || this.closed) {
        return null
      }
      const listener = await this.native.browserProxyStart()
      this.route = listener.route
      if (this.closed) {
        this.route = null
        this.closeNative(() => this.native.browserProxyClose(listener.route))
        return null
      }
      void this.accept(tunnel).catch(() => this.close())
      return { host: '127.0.0.1', port: listener.port }
    } catch (error) {
      this.close()
      throw error
    }
  }

  private async accept(
    tunnel: NonNullable<Awaited<MobileBrowserTunnelConnection<AndroidBrowserTunnelSocket>['ready']>>
  ): Promise<void> {
    const route = this.route!
    while (!this.closed) {
      if (this.peers.size >= 32) {
        await new Promise<void>((resolve) => {
          this.capacity = resolve
        })
      }
      if (this.closed) {
        return
      }
      const id = await this.native.browserProxyAccept(route)
      if (this.closed) {
        return
      }
      this.peers.set(id, null)
      const stream: AndroidBrowserByteStream = {
        read: () => this.native.browserProxyRead(route, id),
        write: (bytes) => this.native.browserProxyWrite(route, id, bytes),
        close: () => {
          if (!this.peers.delete(id)) {
            return
          }
          if (!this.closed) {
            this.closeNative(() => this.native.browserProxyCloseSocket(route, id))
          }
          this.capacity()
        }
      }
      void this.connect(tunnel, id, stream)
    }
  }

  private async connect(
    tunnel: NonNullable<
      Awaited<MobileBrowserTunnelConnection<AndroidBrowserTunnelSocket>['ready']>
    >,
    id: number,
    stream: AndroidBrowserByteStream
  ): Promise<void> {
    const timeout = setTimeout(() => {
      this.peers.get(id)?.destroy(new Error('SOCKS connect timed out'))
      stream.close()
    }, 10_000)
    try {
      const request = await readAndroidSocksTarget(stream)
      if (!this.peers.has(id)) {
        return
      }
      const socket = await tunnel.open(request.target)
      if (this.closed || !this.peers.has(id)) {
        socket.destroy()
        return
      }
      this.peers.set(id, socket)
      await stream.write(ANDROID_SOCKS_REPLY)
      if (!this.peers.has(id)) {
        return
      }
      socket.start(stream, request.initial)
    } catch {
      this.peers.get(id)?.destroy()
      stream.close()
    } finally {
      clearTimeout(timeout)
    }
  }
}

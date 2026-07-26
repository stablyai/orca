# Mobile pairing through a public tunnel

Use a public tunnel when Orca Mobile must reach the desktop runtime from a
network that cannot route directly to the desktop. The public endpoint must be
a WebSocket origin such as `wss://orca.example.com`; paths, query strings, and
embedded credentials are not supported.

This guide uses Cloudflare Tunnel as the concrete example. Orca does not
install, configure, start, or monitor `cloudflared`, and it does not store
Cloudflare credentials.

## Port mapping

The public and origin ports are different:

```text
Orca Mobile
  -> wss://orca.example.com:443
  -> Cloudflare edge TLS termination
  -> cloudflared
  -> http://127.0.0.1:6768
  -> Orca Mobile RPC runtime
```

- `443` is the implicit public port for `wss://`.
- `6768` is Orca's default local Mobile RPC port.
- The Cloudflare service type is **HTTP**, not TCP. The origin is a plain
  HTTP/WebSocket service; Cloudflare provides TLS on the public side.
- Use the actual runtime port if Orca was started with a different port.

## Cloudflare Tunnel route

Create or select a Tunnel whose `cloudflared` connector runs on the same
computer as Orca. Add a published application route with these values:

| Field           | Value                                           |
| --------------- | ----------------------------------------------- |
| Public hostname | A dedicated hostname such as `orca.example.com` |
| Path            | Leave empty                                     |
| Service type    | `HTTP`                                          |
| Service URL     | `http://127.0.0.1:6768`                         |

Prefer `127.0.0.1` over `localhost` when Orca is listening only on IPv4. This
avoids a connector resolving `localhost` to `::1` and failing to reach the
runtime.

For a locally managed Tunnel, the equivalent ingress rule is:

```yaml
tunnel: <TUNNEL-UUID>
credentials-file: /path/to/<TUNNEL-UUID>.json

ingress:
  - hostname: orca.example.com
    service: http://127.0.0.1:6768
  - service: http_status:404
```

Keep the Tunnel token, account certificate, and credentials file outside the
repository. Rotate the Tunnel token if it is exposed.

Cloudflare documents the current dashboard and route fields in
[Set up Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/setup/) and
the HTTP service behavior in
[Protocols for published applications](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/routing-to-tunnel/protocols/).

## Cloudflare Access limitation

Do not protect this hostname with a Cloudflare Access policy for the current
implementation. Access expects a browser authorization cookie, OAuth flow, or
service-token headers. Orca Mobile currently opens the endpoint directly with
`new WebSocket(endpoint)` and does not provide those credentials.

Do not put a Cloudflare service token in the pairing URL. Supporting Access
requires a separate credential storage, rotation, revocation, and request-header
design. Cloudflare's current service-token contract is documented in
[Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

The public hostname is still protected by Orca's device token, pinned desktop
public key, and E2EE handshake. Treat the pairing QR or pairing URL as a secret.

## Configure Orca pairing

1. Start Orca and confirm the Mobile RPC runtime is listening on port `6768`.
2. In **Settings > Mobile**, choose **Add custom endpoint…**.
3. Enter `wss://orca.example.com`. Port `443` may be explicit but is not
   required.
4. Generate the pairing QR code and scan it in Orca Mobile.
5. Use **Direct only** to verify the Tunnel path by itself. Automatic mode may
   race the same direct endpoint against Orca Relay.

## Verification

Check local HTTP reachability first:

```bash
curl --fail --show-error --max-time 10 http://127.0.0.1:6768/
```

Then check the public hostname:

```bash
curl --fail --show-error --max-time 20 https://orca.example.com/
```

Verify that Cloudflare forwards WebSocket upgrades:

```bash
curl --http1.1 --include --max-time 10 \
  --header 'Connection: Upgrade' \
  --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' \
  --header 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://orca.example.com/
```

The WebSocket check must return `101 Switching Protocols`. A successful `101`
proves network and upgrade reachability; it does not prove Orca pairing,
device-token authorization, or E2EE.

Complete the end-to-end check on a physical phone:

1. Disable Wi-Fi so the phone uses cellular data.
2. Pair through the `wss://` endpoint and open a worktree or terminal.
3. Background and foreground the app and verify it reconnects.
4. Restart the Tunnel connector and verify the Mobile client recovers after the
   connector returns.
5. Repeat on iOS and Android before treating the feature as fully verified.

## Troubleshooting

- `502 Bad Gateway`: compare the Tunnel service URL with the port Orca is
  actually listening on. Check `cloudflared` logs for `connection refused`.
- `403`, an Access login page, or an HTTP redirect during WebSocket setup:
  remove the Access policy from this hostname; Access authentication is not yet
  supported by Orca Mobile.
- HTTPS succeeds but the WebSocket check does not return `101`: confirm the
  route uses service type HTTP, has no path restriction, and reaches the Orca
  runtime rather than another local service.
- The hostname works on the desktop but not the phone: test on cellular, check
  public DNS and the certificate, and confirm the pairing endpoint begins with
  `wss://` rather than `ws://`.

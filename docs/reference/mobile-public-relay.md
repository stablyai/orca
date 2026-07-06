# Mobile Pairing Through a Self-Hosted Public Relay

Use this guide when the Orca mobile app must reach a desktop that roams
between networks (office, home, café) and you want a server you already
own to act as the fixed public anchor: a cloud VPS, or a home server
behind a DDNS domain. The only tool required is the SSH access you
already have to that server.

If both devices are always on the same Wi-Fi, you do not need any of
this. If you run Tailscale (or another overlay network), pair with the
overlay address instead; that is the path the pairing UI suggests
first. And if your Orca host is itself a server with a stable address,
see [Headless Linux Server](./headless-linux-server.md) and
`orca serve --pairing-address`; this guide is for the case where the
*desktop* moves around.

Requires Orca v1.4.121 or later on the desktop: earlier versions
rejected plain hostnames in the custom-address dialog
([#7223](https://github.com/stablyai/orca/pull/7223)).

## How It Works

```text
phone ──▶ relay.example.com:28477 ──▶ (reverse tunnel on relay) ──▶ desktop 127.0.0.1:6768
                                            ▲
                              opened outbound by the desktop,
                              so the desktop can be anywhere
```

Three facts make this simple:

- **The desktop runtime listens for mobile connections whenever Orca is
  running.** It is a WebSocket server on `0.0.0.0:6768` by default.
  There is no extra toggle to enable, and the desktop GUI does not
  change the listening port (only `orca serve --port` does).
- **The connection is end-to-end encrypted at the application layer.**
  The pairing QR carries a per-device token and a Curve25519 public
  key; both ends derive a shared key and encrypt everything above the
  socket. The relay forwards ciphertext it cannot read or modify, so a
  plain TCP path is enough and the relay needs no TLS certificate.
  (Passive observers can see the handshake public keys, which are not
  sensitive; the device token is only ever sent encrypted.)
- **The desktop dials out.** The desktop opens an SSH reverse tunnel
  *to* the relay, which makes the relay port forward back to the
  desktop wherever it currently is. The phone only ever connects to the
  relay's fixed address. Public tunnel addresses are an intended
  pairing target: `orca serve --help` describes `--pairing-address` as
  for "a LAN, Tailscale, SSH-forward, or public tunnel address".

## Prerequisites

- A relay server with a public TCP entry point: a VPS, or a home
  machine reachable through DDNS plus a router port-forward.
- SSH access from the desktop to that server.
- Orca v1.4.121+ running on the desktop.
- A relay port. This guide uses `28477`. Prefer an unused port below
  32768; the WSL2 troubleshooting entry below explains why.

## Relay Server: Allow Public Reverse Tunnels

By default, sshd binds reverse-tunnel ports to the server's loopback
interface only. Let the tunnel client choose a public bind address
instead, and make the server drop half-dead tunnel sessions promptly so
their port is freed for the desktop to reconnect. In
`/etc/ssh/sshd_config` (Linux) or `C:\ProgramData\ssh\sshd_config`
(Windows OpenSSH), add:

```text
GatewayPorts clientspecified
ClientAliveInterval 15
ClientAliveCountMax 3
```

Without `ClientAlive*`, a desktop that sleeps or switches networks
leaves the relay holding the old session — and its bound port — until
the kernel's default TCP keepalive reaps it (often ~2 hours), during
which the reconnecting tunnel keeps failing to re-bind the port.

Validate the config before restarting so a typo cannot lock you out:

```bash
# Linux
sudo sshd -t && sudo systemctl restart sshd
```

```powershell
# Windows (elevated PowerShell). The built-in "OpenSSH Server" feature
# installs to C:\Windows\System32\OpenSSH; the standalone MSI installs
# to C:\Program Files\OpenSSH. Use whichever path exists on your host.
& "$env:SystemRoot\System32\OpenSSH\sshd.exe" -t -f C:\ProgramData\ssh\sshd_config
Restart-Service sshd
```

Open the relay port in the server firewall:

```bash
# Linux (ufw)
sudo ufw allow 28477/tcp
```

```powershell
# Windows
New-NetFirewallRule -DisplayName "Orca relay 28477" -Direction Inbound `
  -Protocol TCP -LocalPort 28477 -Action Allow
```

On a cloud VPS, also open the port in the provider's security
group or network firewall (AWS, GCP, Azure, Oracle, and others gate
inbound traffic there before it reaches the host firewall). If the
relay is a home machine behind a router, instead add a port-forward
rule on the router (external `28477` to the server's LAN address, port
`28477`) and confirm your DDNS record points at the home connection's
current public IP.

## Desktop: Keep a Reverse Tunnel Open

Test the tunnel once by hand from the desktop (the machine running
Orca). `user@relay` is your SSH login on the relay server:

```bash
ssh -N -o ExitOnForwardFailure=yes -R 0.0.0.0:28477:127.0.0.1:6768 user@relay
```

This binds `0.0.0.0:28477` on the relay and forwards every connection
back to the desktop's local Orca port. While it runs, verify from a
shell **on the relay server** that traffic really reaches Orca:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:28477/
# 200 means the tunnel reached the desktop's Orca runtime
```

(The `200` is Orca's bundled web client answering through the tunnel.)

Then make the tunnel survive reboots and network changes.

**macOS.** Save as `~/Library/LaunchAgents/com.example.orca-relay.plist`,
replacing `user@relay`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.example.orca-relay</string>
  <key>ProgramArguments</key><array>
    <string>/usr/bin/ssh</string>
    <string>-N</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-o</string><string>ServerAliveInterval=15</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-R</string><string>0.0.0.0:28477:127.0.0.1:6768</string>
    <string>user@relay</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
</dict></plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.orca-relay.plist
```

**Linux.** Simplest is `autossh`; a systemd user unit wrapping the same
`ssh` command works equally well:

```bash
autossh -M 0 -f -N \
  -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
  -R 0.0.0.0:28477:127.0.0.1:6768 user@relay
```

**Windows.** Run the same `ssh -N -R ...` command as a Scheduled Task
(trigger *At log on*, action `ssh.exe` with the arguments above,
restart on failure), or under any service wrapper you already use.

The client-side `ServerAlive*` options make the desktop notice a dead
relay and exit, so the supervisor (launchd, autossh, or Task Scheduler)
restarts it; the relay-side `ClientAlive*` settings above are what free
the bound port in time for that restart to succeed. Together they
re-establish the tunnel after sleep or a network switch.

## Pair the Phone

1. On the desktop, open **Settings → Mobile**. In the
   **Network Interface** section, open the address picker and choose
   **Add custom address…**
2. Enter your relay address with the port, for example
   `relay.example.com:28477`, and confirm with **Use address**.
3. Scan the pairing QR code with the Orca mobile app. To prove the
   public path end to end, turn off Wi-Fi on the phone and pair over
   cellular.

The phone stores this endpoint and keeps using it as the desktop
roams; you do not re-pair when the desktop changes networks. It will
*not* follow a change of relay address, so if you move the relay,
remove the host on the phone and pair again.

Multiple desktops can share one relay: give each its own port
(`28477`, `28478`, …) and its own tunnel. If you also apply the
hardening below, give each desktop its own key with its own
`permitlisten` port, or the second desktop's tunnel is refused.

## Hardening (Optional But Recommended)

Give the tunnel a dedicated SSH key that can do nothing except maintain
this one forward. Generate a key, then prefix its line in
`authorized_keys` on the relay:

```text
restrict,port-forwarding,permitlisten="0.0.0.0:28477" ssh-ed25519 AAAA... orca-relay
```

Two easy mistakes fail with `remote port forwarding failed` only at
connect time: `restrict` alone disables all forwarding, so
`port-forwarding` must be explicitly re-enabled after it, and
`permitlisten` must name the bind address, because a bare
`permitlisten="28477"` does not match a tunnel that asks for a public
`0.0.0.0` bind. Note that `restrict` does not prevent command
execution; use a dedicated low-privilege account on the relay if you
want full confinement.

What the public port exposes: anyone who finds it can load the Orca web
client page and attempt a WebSocket handshake, but taking control
requires the paired device's token and key, which never leave your
devices unencrypted. The relay still terminates raw TCP from the
internet, so treat it like any other public service: keep sshd patched
and use a trusted machine.

## Troubleshooting

- `remote port forwarding failed` at tunnel start: the server is
  missing `GatewayPorts clientspecified`, the port is already taken on
  the server, an `authorized_keys` restriction (above) does not match
  the requested bind address and port, or the desktop reconnected
  before the relay released the previous session's port — set
  `ClientAliveInterval`/`ClientAliveCountMax` on the relay so stale
  sessions are reaped promptly.
- Config changes not applying after an sshd restart: service managers
  sometimes report success without restarting the process. Compare the
  sshd PID before and after with `systemctl show sshd -p MainPID`
  (Linux) or `sc.exe queryex sshd` (Windows).
- Windows relay with WSL2 mirrored networking: `netsh portproxy` rules
  silently do nothing under `networkingMode=mirrored`; the sshd reverse
  tunnel above is the working alternative. Mirrored mode can also
  invisibly reserve port ranges (binds fail with "address in use" while
  `netstat` shows nothing), and ports inside the Linux ephemeral range
  32768–60999 can be claimed at any time, which is why this guide picks
  a relay port below 32768.
- `curl` on the relay returns 200 but the phone cannot connect: that
  check only proves the leg from the relay to the desktop. Test the
  public leg with `curl http://relay.example.com:28477/` from outside
  (for example, the phone on cellular), and re-check the router
  port-forward, host firewall, and any cloud provider security group.
- The address dialog rejects your domain: Orca older than v1.4.121 only
  accepted IPv4 addresses and `*.ts.net` hostnames there; update the
  desktop app.

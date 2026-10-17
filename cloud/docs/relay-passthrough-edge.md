# Relay passthrough edge

> **Status: shelved (2026-10-16). Nothing here is applied.**
> - **Staging proved:** the edge path, the WebSocket and header behaviour, a certificate hot swap, a
>   cell recreate and an edge reset, all with a throwaway CA.
> - **Staging did not prove:** a public certificate, or the DNS cutover and rollback.
> - **Removed:** the staging edge resources were destroyed.

An Orca-run TLS edge answers one relay cell's hostname with no Google proxy in the path. A VM next
to the cell holds a static IP and runs Envoy, which terminates TLS and forwards over the VPC to
the cell VM. It exists to test whether the Google load balancer's asia-east2 proxy tier causes the
Asia `internal_error` stream pulses. Production runs at most one, for `production-gce-c35`.

The cell itself is not changed. It stays behind the shared load balancer, and its image, template,
MIG and every cell workflow are untouched. The edge carries traffic only while Cloudflare points
the cell's exact hostname at the edge IP. Deleting that record is the rollback.

## Pieces

Everything is in `infra/terraform/relay-gce-passthrough-edge.tf`, keyed by
`relay_gce_passthrough_edge_cells`.

| Container on the edge VM | Job |
|---|---|
| `orca-relay-edge` | Envoy. TLS on 443, routing only the cell's own hostname. Rewrites `X-Forwarded-For` to `"<client>, <edge IP>"`, the shape the cell reads (`admissionSource` in `relay-server.ts`). Logs one `orca_relay_edge_stream` line per stream. |
| `orca-relay-edge-acme` | lego. Issues and renews the certificate with DNS-01 and publishes it to Envoy with one rename. |
| `orca-relay-edge-discovery` | Every 5 s, finds the cell VM's address by label and rewrites Envoy's endpoint file. Each minute it logs `orca_relay_edge_stats`. |

- **No internal load balancer.** GCE refuses to put an instance group that the global LB balances by
  `UTILIZATION` behind an ILB, which needs `CONNECTION`.
- **Certificate.** The DNS-01 answer goes into the Cloud DNS zone `relay_gce_edge_acme_domain`.
  Cloudflare delegates that zone, and CNAMEs the cell's `_acme-challenge` name into it. The edge's
  service account can edit only that zone.

## Turn on (each step needs the owner's go in production)

1. **Targeted apply of the ACME zone only:** `-target=google_dns_managed_zone.relay_edge_acme`
   and `-target=google_dns_managed_zone_iam_member.relay_edge_acme_admin`. This comes first because
   Cloudflare needs the zone's name servers, and an edge booted before the delegation logs a renewal
   failure every 15 minutes.
2. **Cloudflare, two records.** The values are in the Terraform outputs:
   - an NS record delegating `relay_gce_edge_acme_domain` to `relay_gce_edge_acme_name_servers`;
   - `_acme-challenge.<host> CNAME <hostname>.<relay_gce_edge_acme_domain>`.
3. **Targeted apply of the edge.** Read the plan first. It must be creates only, with no
   `relay_gce_cell`, URL map or global address in it. The targets:
   - `google_compute_instance.relay_edge`
   - `google_compute_firewall.relay_edge_public`
   - `google_compute_firewall.relay_edge_iap_ssh`
   - `google_compute_firewall.relay_edge_to_cell`
   - `google_monitoring_alert_policy.relay_edge_certificate_check_failures`
   - `google_monitoring_alert_policy.relay_edge_certificate_expiry`
   - `google_monitoring_uptime_check_config.relay_edge_cell`

   The log-metric alert can 404 on its first apply while the metric propagates; re-run the same
   targets.
4. **Wait** for `[orca-relay-edge] certificate published` in the `orca-relay-edge-acme` log.
5. **Probe** with the cell's name pinned to the edge IP. For example,
   `curl --resolve <host>:443:<edge IP> https://<host>/health` must return 200 with a certificate
   that validates against system roots.
6. **Cut over:** Cloudflare `<host> A <edge IP>`, TTL 60, DNS-only. It overrides the wildcard for
   that one name.

## Roll back

Delete the `<host>` A record. Within its 60 s TTL, new resolutions return to the wildcard and the
load balancer. Streams already on the edge stay up until they reconnect. To remove the edge, run a
targeted destroy of the step-1 and step-3 targets and delete the two Cloudflare records.

## Watch

- **`orca_relay_edge_stream` (per stream, at close):**
  - `flags` shows who ended the stream: `DC` the client side, `UC` the cell side;
  - `termination` and `upstreamFailure` explain resets.
- **`orca_relay_edge_stats` (per minute):**
  - `upgradesActive` is the WebSocket count through the edge, the denominator for drops;
  - `tlsHandshakeErrors` and `upstreamConnectFailures` should stay flat outside incidents.
- **Alerts (notify only):**
  - `Orca Relay: edge certificate renewal failed`;
  - `Orca Relay: edge cell certificate expires within 21 days`. Its uptime check reads whatever
    certificate the hostname serves.
- **Lost signals.** Load-balancer logs and `https/request_count` no longer see edge-path traffic for
  the cell. The cell's own 1006 metric and runtime metrics are unchanged.

## Maintenance

- **Config edits.** Updating the startup script updates the VM's metadata in place. Re-run it with
  `sudo google_metadata_script_runner startup`, which restarts Envoy and drops edge streams, so do it
  behind a DNS rollback or accept a cell-restart-sized blip.
- **Do not recreate the VM casually.** The certificate lives on its boot disk, so a new VM reissues
  it, and Let's Encrypt allows five duplicate certificates a week.

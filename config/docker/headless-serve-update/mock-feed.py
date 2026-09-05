#!/usr/bin/env python3
"""Minimal static HTTP file server for the update-feed E2E case.

Serves /srv/feed so electron-updater (generic provider) can poll
latest-linux.yml and download the artifact. stdlib only.
"""
import argparse
import functools
import http.server
import os

ROOT = "/srv/feed"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        pass  # keep container logs quiet


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8123)
    parser.add_argument("--root", default=ROOT)
    args = parser.parse_args()
    os.chdir(args.root)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", args.port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()

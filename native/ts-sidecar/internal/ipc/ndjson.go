package ipc

import (
	"bufio"
	"encoding/json"
	"io"
)

// MaxLineBytes bounds a single NDJSON line so a peer that never sends a newline
// cannot grow the read buffer without limit. Matches the TS parser's default.
const MaxLineBytes = 16 * 1024 * 1024

// EncodeLine marshals a message and appends the newline framing byte.
func EncodeLine(msg any) ([]byte, error) {
	b, err := json.Marshal(msg)
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// ReadRequests reads newline-delimited requests from r, invoking onRequest for
// each. It returns when r is exhausted or a non-recoverable read error occurs.
// Malformed JSON lines are reported via onError and skipped, not fatal, so one
// bad line does not tear down the connection.
func ReadRequests(r io.Reader, onRequest func(Request), onError func(error)) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 0, 64*1024), MaxLineBytes)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var req Request
		if err := json.Unmarshal(line, &req); err != nil {
			if onError != nil {
				onError(err)
			}
			continue
		}
		onRequest(req)
	}
	return scanner.Err()
}
